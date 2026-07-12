import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComposeOptions, MusicConfig, OutputSettings } from "./types.js";

const CRF_HIGH = 18;
const CRF_MEDIUM = 28;
export const AUDIO_SAMPLE_RATE = 44100;

function crfForQuality(quality: string): number {
  return quality === "high" ? CRF_HIGH : CRF_MEDIUM;
}

/**
 * Normalized encode args shared by every segment (browser recordings and
 * rendered cards). Identical codec, pixel format, frame rate, and audio
 * params across segments is what lets the concat demuxer stream-copy them
 * together in {@link concatSegments} without re-encoding.
 */
export function segmentOutputArgs(quality: string, fps: number): string[] {
  return [
    "-c:v",
    "libx264",
    "-crf",
    String(crfForQuality(quality)),
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
  ];
}

function runFfmpeg(args: string[], label: string): void {
  try {
    execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "inherit"] });
  } catch (err) {
    throw new Error(
      `ffmpeg ${label} failed.\nCommand: ffmpeg ${args.join(" ")}\nCause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Compose a single browser segment: overlay narration audio onto the
 * Playwright recording at the correct timestamps and normalize the encode
 * so the result can be concatenated with other segments.
 *
 * Uses an adelay + amix filter graph to place each narration clip at its
 * recorded video offset. When the segment has no narration clips, a silent
 * stereo track is attached so every segment carries an audio stream (required
 * for clean concat and for the background-music mix later).
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
    console.warn("  [composer] no matched clips — attaching a silent audio track");
    const args = [
      "-i",
      videoPath,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      ...segmentOutputArgs(output.quality, output.fps),
      "-shortest",
      "-y",
      outputPath,
    ];
    runFfmpeg(args, "silent-segment compose");
    return outputPath;
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

  const args = [
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    ...segmentOutputArgs(output.quality, output.fps),
    "-y",
    outputPath,
  ];

  console.log(`  [composer] composing ${clips.length} narration clips into segment`);
  runFfmpeg(args, "segment compose");
  console.log(`  [composer] segment: ${outputPath}`);

  return outputPath;
}

/**
 * Concatenate normalized segments into a single video in list order.
 *
 * All segments share the encode params from {@link segmentOutputArgs}, so the
 * concat demuxer can stream-copy them (`-c copy`). If that fails for any
 * reason, falls back to the concat filter, which re-encodes.
 */
export function concatSegments(
  segmentPaths: string[],
  outputPath: string,
  output: OutputSettings,
): string {
  mkdirSync(dirname(outputPath), { recursive: true });

  if (segmentPaths.length === 0) {
    throw new Error("concatSegments: no segments to concatenate");
  }

  if (segmentPaths.length === 1) {
    const only = segmentPaths[0] as string;
    runFfmpeg(
      ["-i", only, "-c", "copy", "-movflags", "+faststart", "-y", outputPath],
      "single-segment copy",
    );
    return outputPath;
  }

  const listPath = join(dirname(outputPath), "concat-list.txt");
  const listBody = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, `${listBody}\n`, "utf-8");

  try {
    runFfmpeg(
      [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        outputPath,
      ],
      "concat (stream copy)",
    );
    return outputPath;
  } catch (err) {
    console.warn(
      `  [composer] stream-copy concat failed, re-encoding via concat filter: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Fallback: concat filter, re-encoding everything to normalized params.
  const inputArgs: string[] = [];
  for (const p of segmentPaths) inputArgs.push("-i", p);
  const streams = segmentPaths.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const filter = `${streams}concat=n=${segmentPaths.length}:v=1:a=1[v][a]`;
  runFfmpeg(
    [
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "[a]",
      ...segmentOutputArgs(output.quality, output.fps),
      "-y",
      outputPath,
    ],
    "concat (filter re-encode)",
  );
  return outputPath;
}

/**
 * Mix a looping background-music bed under an already-composed video. The
 * music is looped to cover the whole timeline, volume-scaled, optionally
 * faded in/out, and trimmed to the video length. The video stream is copied
 * (no re-encode); only audio is re-encoded.
 */
export function mixBackgroundMusic(opts: {
  videoPath: string;
  music: MusicConfig;
  musicPath: string;
  totalDurationMs: number;
  outputPath: string;
}): string {
  const { videoPath, music, musicPath, totalDurationMs, outputPath } = opts;
  mkdirSync(dirname(outputPath), { recursive: true });

  const totalSec = totalDurationMs / 1000;
  const bgFilters = [`volume=${music.volume}`];
  if (music.fade_in_ms && music.fade_in_ms > 0) {
    bgFilters.push(`afade=t=in:st=0:d=${music.fade_in_ms / 1000}`);
  }
  if (music.fade_out_ms && music.fade_out_ms > 0) {
    const st = Math.max(0, totalSec - music.fade_out_ms / 1000);
    bgFilters.push(`afade=t=out:st=${st}:d=${music.fade_out_ms / 1000}`);
  }

  const filter = `[1:a]${bgFilters.join(",")}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[aout]`;

  const args = [
    "-i",
    videoPath,
    "-stream_loop",
    "-1",
    "-i",
    musicPath,
    "-filter_complex",
    filter,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-shortest",
    "-y",
    outputPath,
  ];

  console.log(`  [composer] mixing background music (volume=${music.volume}) under video`);
  runFfmpeg(args, "music mix");
  console.log(`  [composer] output: ${outputPath}`);
  return outputPath;
}

export function checkComposerPrerequisites(): void {
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "pipe" });
  } catch {
    throw new Error("ffmpeg not found. Install with: brew install ffmpeg");
  }
}
