import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkComposerPrerequisites, composeDemoVideo } from "./composer.js";
import { checkNarratorPrerequisites, generateNarration } from "./narrator.js";
import { recordDemo } from "./recorder.js";
import type { PipelineResult, RunOptions } from "./types.js";
import { parseDemoScript } from "./types.js";

/**
 * Run the full demo recording pipeline:
 *   1. Parse and validate the YAML script
 *   2. Pre-generate all narration audio (with caching)
 *   3. Record the browser with narration-aware timing
 *   4. Compose final video with narration overlay
 */
export async function runDemoPipeline(
  scriptPath: string,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const {
    skipNarration = false,
    skipComposition = false,
    headless = true,
    outDir,
    setupAuth,
  } = opts;

  console.log("[pipeline] parsing demo script...");
  const script = parseDemoScript(resolve(scriptPath));
  console.log(`[pipeline] demo: ${script.meta.name} (${script.scenes.length} scenes)`);

  if (!skipNarration) checkNarratorPrerequisites();
  if (!skipComposition) checkComposerPrerequisites();

  // Resolve baseURL: explicit option > env > YAML > localhost default
  const baseURL =
    opts.baseURL ??
    process.env.DEMOGEN_BASE_URL ??
    script.base_url ??
    "http://localhost:3000";

  // Output directories
  const baseDir = outDir ? resolve(outDir) : join(dirname(resolve(scriptPath)), "demogen-out");
  const narrationDir = join(baseDir, "narration", script.meta.name);
  const recordingsDir = join(baseDir, "recordings", script.meta.name);
  const outputDir = join(baseDir, "output");
  const outputPath = join(outputDir, `${script.meta.name}.mp4`);

  mkdirSync(narrationDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  console.log("[pipeline] phase 1: generating narration...");
  const manifest = skipNarration ? new Map() : await generateNarration(script, narrationDir);
  console.log(`[pipeline] narration: ${manifest.size} clips generated`);

  console.log(`[pipeline] phase 2: recording browser (baseURL=${baseURL})...`);
  const recording = await recordDemo(script, manifest, recordingsDir, {
    headless,
    baseURL,
    setupAuth,
  });
  console.log(
    `[pipeline] recording: ${recording.totalDurationMs}ms, ${recording.narrationTimeline.size} timeline entries`,
  );

  if (skipComposition) {
    console.log("[pipeline] skipping composition (--skip-composition)");
    return {
      outputPath: recording.videoPath,
      durationMs: recording.totalDurationMs,
      clipCount: manifest.size,
      sceneCount: script.scenes.length,
    };
  }

  console.log("[pipeline] phase 3: composing final video...");
  const finalPath = await composeDemoVideo({
    videoPath: recording.videoPath,
    manifest,
    timeline: recording.narrationTimeline,
    output: script.output,
    outputPath,
  });

  console.log(`[pipeline] done: ${finalPath}`);

  return {
    outputPath: finalPath,
    durationMs: recording.totalDurationMs,
    clipCount: manifest.size,
    sceneCount: script.scenes.length,
  };
}
