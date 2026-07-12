import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  cardDurationMs,
  composeCardSegment,
  renderCardImage,
} from "./cards.js";
import {
  checkComposerPrerequisites,
  composeDemoVideo,
  concatWithTransitions,
  extractSegment,
  mixBackgroundMusic,
  probeMediaDurationMs,
  type TransitionItem,
} from "./composer.js";
import { isHardCut, transitionDurationMs } from "./transitions.js";
import { loadDemogenEnv } from "./env.js";
import { checkNarratorPrerequisites, generateNarration } from "./narrator.js";
import { recordDemo } from "./recorder.js";
import type {
  BrowserScene,
  DemoCardScene,
  DemoScene,
  NarrationManifest,
  PipelineResult,
  RunOptions,
} from "./types.js";
import { parseDemoScript } from "./types.js";

type Segment =
  | { kind: "browser"; scenes: BrowserScene[] }
  | { kind: "card"; card: DemoCardScene };

/**
 * Split the scene list into an ordered sequence of segments: each maximal run
 * of contiguous browser scenes becomes one browser segment; each card scene
 * becomes its own card segment. Order is preserved so cards land exactly where
 * they were authored.
 */
export function groupScenes(scenes: DemoScene[]): Segment[] {
  const segments: Segment[] = [];
  let run: BrowserScene[] | null = null;

  for (const scene of scenes) {
    if (scene.type === "card") {
      if (run) {
        segments.push({ kind: "browser", scenes: run });
        run = null;
      }
      segments.push({ kind: "card", card: scene });
    } else {
      (run ??= []).push(scene);
    }
  }
  if (run) segments.push({ kind: "browser", scenes: run });
  return segments;
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Run the full demo recording pipeline:
 *   1. Parse and validate the YAML script
 *   2. Pre-generate all narration audio (with caching)
 *   3. Build each segment: record browser runs, render card slates
 *   4. Concatenate the segments, then mix in optional background music
 *
 * Default directory layout (rooted at the script's project, or --out-dir):
 *   ./demos/source/           — YAML demo scripts (informational; not enforced)
 *   ./demos/interstitial/     — narration clips, raw .webm recordings, segments
 *   ./demos/output/           — final .mp4 files
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
    interstitialDir,
    outputDir,
    voicesPath,
    envPath,
    setupAuth,
  } = opts;

  // Load env file before any DEMOGEN_* / *_API_KEY lookups so the rest of
  // the pipeline sees a consistent view. Idempotent if already loaded by CLI.
  const loadedEnv = loadDemogenEnv(envPath);
  if (loadedEnv) console.log(`[pipeline] loaded env from ${loadedEnv}`);

  const resolvedScriptPath = resolve(scriptPath);
  console.log("[pipeline] parsing demo script...");
  const script = parseDemoScript(resolvedScriptPath);
  const cardCount = script.scenes.filter((s) => s.type === "card").length;
  console.log(
    `[pipeline] demo: ${script.meta.name} (${script.scenes.length} scenes, ${cardCount} cards)`,
  );

  if (!skipNarration) checkNarratorPrerequisites();
  if (!skipComposition) checkComposerPrerequisites();

  // Resolve baseURL: explicit option > env > YAML > localhost default
  const baseURL =
    opts.baseURL ??
    process.env.DEMOGEN_BASE_URL ??
    script.base_url ??
    "http://localhost:3000";

  // Directory resolution: --out-dir sets the base; per-purpose flags/env
  // override the interstitial/ and output/ subdirs individually.
  const baseDir = outDir
    ? resolve(outDir)
    : process.env.DEMOGEN_OUT_DIR
    ? resolve(process.env.DEMOGEN_OUT_DIR)
    : join(dirname(resolvedScriptPath), "demos");

  const interstitialBase =
    interstitialDir ??
    process.env.DEMOGEN_INTERSTITIAL_DIR ??
    join(baseDir, "interstitial");
  const outputBase =
    outputDir ??
    process.env.DEMOGEN_OUTPUT_DIR ??
    join(baseDir, "output");

  const narrationDir = join(resolve(interstitialBase), "narration", script.meta.name);
  const recordingsDir = join(resolve(interstitialBase), "recordings", script.meta.name);
  const finalOutputDir = resolve(outputBase);
  const outputPath = join(finalOutputDir, `${script.meta.name}.mp4`);

  mkdirSync(narrationDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
  mkdirSync(finalOutputDir, { recursive: true });

  console.log("[pipeline] phase 1: generating narration...");
  const manifest: NarrationManifest = skipNarration
    ? new Map()
    : await generateNarration(script, narrationDir, voicesPath);
  console.log(`[pipeline] narration: ${manifest.size} clips generated`);

  const segments = groupScenes(script.scenes);
  console.log(
    `[pipeline] phase 2: building ${segments.length} segments (baseURL=${baseURL})...`,
  );

  // Ordered concat items: each composed segment plus the transition that joins
  // it to the item before it. A browser run may split into several items when
  // its scenes request blended transitions (see below).
  const items: TransitionItem[] = [];
  let totalDurationMs = 0;
  let firstRecordingPath: string | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as Segment;
    const segmentPath = join(recordingsDir, `seg-${pad(i)}.mp4`);

    if (segment.kind === "browser") {
      const runScenes = segment.scenes;
      const firstScene = runScenes[0] as BrowserScene;
      console.log(`[pipeline]   segment ${i}: browser (${runScenes.length} scenes)`);
      const recording = await recordDemo(script, runScenes, manifest, recordingsDir, {
        headless,
        baseURL,
        setupAuth,
      });
      firstRecordingPath ??= recording.videoPath;
      totalDurationMs += recording.totalDurationMs;

      if (skipComposition) continue;

      // Compose the whole run (narration overlaid) into one mp4, preserving the
      // continuous browsing session.
      await composeDemoVideo({
        videoPath: recording.videoPath,
        manifest,
        timeline: recording.narrationTimeline,
        output: script.output,
        outputPath: segmentPath,
      });

      // Split the run at each internal scene that asks for a blended transition,
      // so that scene becomes its own concat item. Scenes joined by hard cuts
      // stay merged in the same item (no re-render needed).
      const splitIdx = runScenes
        .map((s, idx) => ({ s, idx }))
        .filter(
          ({ s, idx }) =>
            idx > 0 &&
            !isHardCut(s.transition) &&
            transitionDurationMs(s.transition, s.transition_duration) > 0,
        );

      if (splitIdx.length === 0) {
        items.push({
          path: segmentPath,
          transition: firstScene.transition,
          transitionDurationMs: firstScene.transition_duration,
        });
      } else {
        const pieceScenes = [firstScene, ...splitIdx.map(({ s }) => s)];
        const startMsList = [0, ...splitIdx.map(({ idx }) => recording.sceneBoundaries[idx]?.startMs ?? 0)];
        for (let p = 0; p < startMsList.length; p++) {
          const startSec = (startMsList[p] as number) / 1000;
          const nextMs = startMsList[p + 1];
          const endSec = nextMs != null ? nextMs / 1000 : undefined;
          const piecePath = join(recordingsDir, `seg-${pad(i)}-${pad(p)}.mp4`);
          extractSegment(segmentPath, startSec, endSec, piecePath, script.output);
          const sc = pieceScenes[p] as BrowserScene;
          items.push({
            path: piecePath,
            transition: sc.transition,
            transitionDurationMs: sc.transition_duration,
          });
        }
        console.log(`[pipeline]     split browser run into ${startMsList.length} transition pieces`);
      }
    } else {
      const { card } = segment;
      const narration = card.clip ? manifest.get(card.clip) : undefined;
      const durationMs = cardDurationMs(card, narration?.durationMs);
      totalDurationMs += durationMs;
      console.log(`[pipeline]   segment ${i}: card "${card.id}" (${card.kind}, ${durationMs}ms)`);

      if (skipComposition) continue;

      const pngPath = join(recordingsDir, `card-${card.id}.png`);
      await renderCardImage(card, script.output.resolution, pngPath);
      composeCardSegment({
        pngPath,
        durationMs,
        fade: card.fade,
        narration,
        quality: script.output.quality,
        fps: script.output.fps,
        outputPath: segmentPath,
      });
      items.push({
        path: segmentPath,
        transition: card.transition,
        transitionDurationMs: card.transition_duration,
      });
    }
  }

  if (skipComposition) {
    console.log("[pipeline] skipping composition (--skip-composition)");
    return {
      outputPath: firstRecordingPath ?? recordingsDir,
      durationMs: totalDurationMs,
      clipCount: manifest.size,
      sceneCount: script.scenes.length,
      cardCount,
    };
  }

  console.log(`[pipeline] phase 3: concatenating ${items.length} items with transitions...`);
  const music = script.music;
  const concatTarget = music ? join(recordingsDir, "combined.mp4") : outputPath;
  concatWithTransitions(items, concatTarget, script.output);

  // Blended transitions overlap segments, so the true length is only known
  // after concat — probe it for accurate music fade-out timing and reporting.
  const combinedMs = probeMediaDurationMs(concatTarget);

  let finalPath = concatTarget;
  if (music) {
    const musicPath = resolve(dirname(resolvedScriptPath), music.path);
    if (!existsSync(musicPath)) {
      throw new Error(`Background music file not found: ${musicPath} (from music.path "${music.path}")`);
    }
    console.log("[pipeline] phase 4: mixing background music...");
    finalPath = mixBackgroundMusic({
      videoPath: concatTarget,
      music,
      musicPath,
      totalDurationMs: combinedMs,
      outputPath,
    });
  }

  console.log(`[pipeline] done: ${finalPath}`);

  return {
    outputPath: finalPath,
    durationMs: combinedMs,
    clipCount: manifest.size,
    sceneCount: script.scenes.length,
    cardCount,
  };
}
