import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHardCut, resolveTransition, transitionDurationMs } from "./transitions.js";
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
 * Extract a time range from a composed segment into its own normalized mp4.
 * Used to split one continuous browser run (recorded as a single video to keep
 * the session/navigation continuous) into per-scene segments so scene-level
 * transitions can be applied between them. Re-encodes with {@link segmentOutputArgs}
 * so the pieces concatenate/xfade cleanly with everything else.
 */
export function extractSegment(
  inputPath: string,
  startSec: number,
  endSec: number | undefined,
  outputPath: string,
  output: OutputSettings,
): string {
  mkdirSync(dirname(outputPath), { recursive: true });
  const args = ["-i", inputPath, "-ss", startSec.toFixed(3)];
  if (endSec != null) args.push("-to", endSec.toFixed(3));
  args.push(...segmentOutputArgs(output.quality, output.fps), "-y", outputPath);
  runFfmpeg(args, "segment extract");
  return outputPath;
}

/**
 * One item in a transition-aware concat: a composed segment plus the transition
 * that joins it to the segment before it. The first item's transition is ignored
 * (nothing precedes it).
 */
export interface TransitionItem {
  path: string;
  /** Transition name (registry key) joining this item to the previous one. */
  transition: string;
  /** Explicit blend duration (ms); falls back to the transition's default. */
  transitionDurationMs?: number;
}

/** A run of items joined only by hard cuts, plus the transition into the run. */
interface Cluster {
  paths: string[];
  /** Transition joining this cluster to the previous cluster. */
  transition: string;
  transitionDurationMs?: number;
}

/**
 * Group items into clusters separated by blended transitions. Consecutive items
 * joined by a hard cut (or a zero-duration transition) collapse into one cluster
 * that will be plain-concatenated; each blended transition starts a new cluster
 * whose boundary is rendered with xfade. Pure — unit tested.
 */
export function clusterByCuts(items: TransitionItem[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as TransitionItem;
    const cutBoundary =
      isHardCut(it.transition) || transitionDurationMs(it.transition, it.transitionDurationMs) <= 0;
    if (i > 0 && cutBoundary) {
      (clusters[clusters.length - 1] as Cluster).paths.push(it.path);
    } else {
      clusters.push({
        paths: [it.path],
        transition: it.transition,
        transitionDurationMs: it.transitionDurationMs,
      });
    }
  }
  return clusters;
}

/**
 * Probe a media file's duration in milliseconds via ffprobe.
 */
export function probeMediaDurationMs(path: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf-8" },
  ).trim();
  return Math.round(parseFloat(out) * 1000);
}

/**
 * Build the ffmpeg `-filter_complex` for an xfade/acrossfade chain across
 * clusters. Input N (`[N:v]`/`[N:a]`) is cluster N. Each blended boundary
 * overlaps the streams by its (clamped) duration, so both the video (xfade) and
 * audio (acrossfade) chains shrink by the same amount and stay in sync. The
 * first cluster's transition is ignored. Pure — unit tested.
 */
export function planXfadeChain(
  clusters: Array<{ durationSec: number; transition: string; durationOverrideSec?: number }>,
): { filterComplex: string; vOut: string; aOut: string } {
  if (clusters.length < 2) {
    throw new Error("planXfadeChain requires at least 2 clusters");
  }
  const parts: string[] = [];
  let vPrev = "[0:v]";
  let aPrev = "[0:a]";
  let running = (clusters[0] as { durationSec: number }).durationSec;

  for (let i = 1; i < clusters.length; i++) {
    const c = clusters[i] as { durationSec: number; transition: string; durationOverrideSec?: number };
    const def = resolveTransition(c.transition);
    const xid = def.xfade;
    if (!xid) throw new Error(`planXfadeChain: cluster ${i} has a hard-cut transition "${c.transition}"`);

    const wanted = c.durationOverrideSec ?? def.defaultDurationMs / 1000;
    // Clamp so the overlap fits inside both the accumulated left stream and the
    // incoming cluster, leaving a small margin.
    const maxD = Math.max(0.05, Math.min(running, c.durationSec) - 0.05);
    const d = Math.min(wanted, maxD);
    const offset = Math.max(0, running - d);

    const last = i === clusters.length - 1;
    const vLabel = last ? "[vout]" : `[vx${i}]`;
    const aLabel = last ? "[aout]" : `[ax${i}]`;
    parts.push(
      `${vPrev}[${i}:v]xfade=transition=${xid}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}${vLabel}`,
    );
    parts.push(`${aPrev}[${i}:a]acrossfade=d=${d.toFixed(3)}${aLabel}`);

    vPrev = vLabel;
    aPrev = aLabel;
    running = running + c.durationSec - d;
  }

  return { filterComplex: parts.join(";"), vOut: "[vout]", aOut: "[aout]" };
}

/**
 * Concatenate composed segments, applying blended scene transitions (xfade)
 * where requested and hard cuts everywhere else. When every join is a hard cut
 * this delegates to {@link concatSegments} (fast stream-copy). Otherwise it
 * collapses hard-cut runs, probes durations, and renders one xfade/acrossfade
 * chain over the collapsed clusters.
 */
export function concatWithTransitions(
  items: TransitionItem[],
  outputPath: string,
  output: OutputSettings,
): string {
  mkdirSync(dirname(outputPath), { recursive: true });

  if (items.length === 0) {
    throw new Error("concatWithTransitions: no segments to concatenate");
  }
  if (items.length === 1) {
    return concatSegments([(items[0] as TransitionItem).path], outputPath, output);
  }

  const clusters = clusterByCuts(items);
  if (clusters.length === 1) {
    // No blended transitions — plain concat over all segments.
    return concatSegments(
      items.map((i) => i.path),
      outputPath,
      output,
    );
  }

  // Collapse each hard-cut cluster into a single normalized mp4 so the xfade
  // chain operates on one input per cluster.
  const clusterPaths = clusters.map((c, idx) => {
    if (c.paths.length === 1) return c.paths[0] as string;
    const merged = join(dirname(outputPath), `xfade-cluster-${idx}.mp4`);
    concatSegments(c.paths, merged, output);
    return merged;
  });

  const planClusters = clusters.map((c, idx) => ({
    durationSec: probeMediaDurationMs(clusterPaths[idx] as string) / 1000,
    transition: c.transition,
    durationOverrideSec:
      c.transitionDurationMs != null ? c.transitionDurationMs / 1000 : undefined,
  }));

  const { filterComplex, vOut, aOut } = planXfadeChain(planClusters);

  const inputArgs: string[] = [];
  for (const p of clusterPaths) inputArgs.push("-i", p);

  const args = [
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    vOut,
    "-map",
    aOut,
    ...segmentOutputArgs(output.quality, output.fps),
    "-y",
    outputPath,
  ];

  console.log(
    `  [composer] xfade concat: ${clusters.length} clusters, ${
      clusters.length - 1
    } blended transition(s)`,
  );
  runFfmpeg(args, "xfade concat");
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
