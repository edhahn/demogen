import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import { AUDIO_SAMPLE_RATE, segmentOutputArgs } from "./composer.js";
import type { DemoCardScene } from "./types.js";

const FADE_SEC = 0.4;

const NARRATION_LEAD_MS = FADE_SEC * 1000;
const NARRATION_TAIL_MS = 800;

/**
 * How long a card holds on screen: at least its configured `duration_ms`, and
 * long enough to fit its voiceover (lead-in + clip + tail) when it has one.
 */
export function cardDurationMs(card: DemoCardScene, narrationDurationMs?: number): number {
  if (narrationDurationMs == null) return card.duration_ms;
  return Math.max(card.duration_ms, narrationDurationMs + NARRATION_LEAD_MS + NARRATION_TAIL_MS);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a self-contained HTML document for a card scene. Full-viewport,
 * vertically/horizontally centered, dark default background. Font sizes scale
 * with the output height so a card reads the same at 720p or 1080p.
 */
export function buildCardHtml(
  card: DemoCardScene,
  resolution: { width: number; height: number },
): string {
  const scale = resolution.height / 720;
  const px = (base: number) => Math.round(base * scale);

  const background =
    card.background ?? "radial-gradient(ellipse at top, #16233b 0%, #0b1220 70%)";

  const headline = `<h1 style="margin:0;font-size:${px(72)}px;font-weight:700;letter-spacing:-0.02em;line-height:1.1;">${escapeHtml(
    card.headline,
  )}</h1>`;

  const subtitle = card.subtitle
    ? `<p style="margin:${px(20)}px 0 0;font-size:${px(32)}px;font-weight:400;color:#9fb0c8;">${escapeHtml(
        card.subtitle,
      )}</p>`
    : "";

  const lines =
    card.lines && card.lines.length > 0
      ? `<div style="margin-top:${px(36)}px;display:flex;flex-direction:column;gap:${px(
          10,
        )}px;">${card.lines
          .map(
            (l) =>
              `<span style="font-size:${px(28)}px;color:#c3cede;">${escapeHtml(l)}</span>`,
          )
          .join("")}</div>`
      : "";

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  body {
    width: ${resolution.width}px;
    height: ${resolution.height}px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    background: ${background};
    color: #f5f8ff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { padding: ${px(48)}px ${px(72)}px; max-width: 82%; }
</style></head>
<body><div class="card">${headline}${subtitle}${lines}</div></body>
</html>`;
}

/**
 * Render a card scene to a PNG using the same headless Chromium the recorder
 * uses. The page is sized to the output resolution and screenshotted.
 */
export async function renderCardImage(
  card: DemoCardScene,
  resolution: { width: number; height: number },
  outPath: string,
): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: resolution });
    await page.setContent(buildCardHtml(card, resolution), { waitUntil: "load" });
    // Give web fonts / layout a beat to settle before the screenshot.
    await page.waitForTimeout(150);
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
  return outPath;
}

/**
 * Turn a rendered card PNG into a normalized video segment. The still image is
 * looped for `durationMs`; a narration clip (if provided) is placed shortly
 * after the fade-in, and the segment is optionally faded in/out to black. The
 * encode matches {@link segmentOutputArgs} so it concatenates cleanly with
 * browser segments.
 */
export function composeCardSegment(opts: {
  pngPath: string;
  durationMs: number;
  fade: boolean;
  narration?: { audioPath: string; durationMs: number };
  quality: string;
  fps: number;
  outputPath: string;
}): string {
  const { pngPath, durationMs, fade, narration, quality, fps, outputPath } = opts;
  mkdirSync(dirname(outputPath), { recursive: true });

  const dur = durationMs / 1000;
  const fadeOutStart = Math.max(0, dur - FADE_SEC);

  const videoFilter = fade
    ? `[0:v]fade=t=in:st=0:d=${FADE_SEC},fade=t=out:st=${fadeOutStart}:d=${FADE_SEC},format=yuv420p[v]`
    : `[0:v]format=yuv420p[v]`;

  const inputArgs = ["-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", pngPath];

  let audioFilter: string;
  if (narration) {
    inputArgs.push("-i", narration.audioPath);
    // Small lead-in so the voiceover starts just after the card appears, then
    // pad with silence and cap to the segment length.
    audioFilter = `[1:a]adelay=${Math.round(FADE_SEC * 1000)}:all=1,apad,atrim=0:${dur}[a]`;
  } else {
    inputArgs.push("-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`);
    audioFilter = `[1:a]atrim=0:${dur}[a]`;
  }

  const args = [
    ...inputArgs,
    "-filter_complex",
    `${videoFilter};${audioFilter}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...segmentOutputArgs(quality, fps),
    "-t",
    String(dur),
    "-y",
    outputPath,
  ];

  try {
    execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "inherit"] });
  } catch (err) {
    throw new Error(
      `ffmpeg card compose failed.\nCommand: ffmpeg ${args.join(" ")}\nCause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return outputPath;
}
