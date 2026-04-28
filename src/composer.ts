import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ComposeOptions } from "./types.js";

const CRF_HIGH = 18;
const CRF_MEDIUM = 28;

/**
 * Compose a final demo video by overlaying narration audio onto the
 * Playwright recording at the correct timestamps.
 *
 * Uses a single ffmpeg command with an adelay + amix filter graph to
 * place each narration clip at its recorded video offset.
 */
export async function composeDemoVideo(opts: ComposeOptions): Promise<string> {
  const { videoPath, manifest, timeline, output, outputPath } = opts;

  mkdirSync(dirname(outputPath), { recursive: true });

  const clips: Array<{ clipId: string; audioPath: string; offsetMs: number }> = [];
  console.log(`  [composer] manifest: ${manifest.size} clips, timeline: ${timeline.size} entries`);
  for (const [clipId, entry] of timeline) {
    const manifestEntry = manifest.get(clipId);
    if (manifestEntry) {
      clips.push({
        clipId,
        audioPath: manifestEntry.audioPath,
        offsetMs: entry.videoOffsetMs,
      });
      console.log(
        `  [composer] clip "${clipId}" at ${entry.videoOffsetMs}ms → ${manifestEntry.audioPath}`,
      );
    } else {
      console.warn(`  [composer] WARNING: timeline clip "${clipId}" not found in manifest`);
    }
  }

  if (clips.length === 0) {
    console.warn("  [composer] WARNING: no matched clips — composing without narration audio");
    return transcodeVideo(videoPath, outputPath, output.quality);
  }

  const inputArgs = ["-i", videoPath];
  for (const clip of clips) {
    inputArgs.push("-i", clip.audioPath);
  }

  const filterParts: string[] = [];
  const mixInputs: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const inputIdx = i + 1;
    const label = `a${i}`;
    const clip = clips[i];
    if (!clip) continue;
    const delayMs = Math.round(clip.offsetMs);
    filterParts.push(`[${inputIdx}:a]adelay=${delayMs}:all=1[${label}]`);
    mixInputs.push(`[${label}]`);
  }

  const mixFilter =
    clips.length === 1
      ? `${mixInputs[0]}anull[aout]`
      : `${mixInputs.join("")}amix=inputs=${clips.length}:duration=longest:normalize=0[aout]`;

  const filterComplex = `${filterParts.join(";")}; ${mixFilter}`;

  const crf = output.quality === "high" ? CRF_HIGH : CRF_MEDIUM;

  const args = [
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-crf",
    String(crf),
    "-preset",
    "medium",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];

  console.log(`  [composer] composing ${clips.length} narration clips into video`);
  try {
    execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "inherit"] });
  } catch (err) {
    throw new Error(
      `ffmpeg composition failed.\nCommand: ffmpeg ${args.join(" ")}\nCause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`  [composer] output: ${outputPath}`);

  return outputPath;
}

function transcodeVideo(inputPath: string, outputPath: string, quality: string): string {
  const crf = quality === "high" ? CRF_HIGH : CRF_MEDIUM;
  execFileSync(
    "ffmpeg",
    [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-crf",
      String(crf),
      "-preset",
      "medium",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ],
    { stdio: "pipe" },
  );
  return outputPath;
}

export function checkComposerPrerequisites(): void {
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "pipe" });
  } catch {
    throw new Error("ffmpeg not found. Install with: brew install ffmpeg");
  }
}
