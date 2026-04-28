import { chromium } from "@playwright/test";
import type { CursorOptions } from "./cursor.js";
import {
  animateCursorTo,
  injectCursorOverlay,
  installCursorOverlay,
  primeCursorPosition,
} from "./cursor.js";
import type {
  DemoScript,
  DemoStep,
  NarrationManifest,
  NarrationTimeline,
  RecordingResult,
  SetupAuthFn,
} from "./types.js";

const DEFAULT_WAIT_AFTER_MS = 1000;

export interface RecordOptions {
  headless?: boolean;
  baseURL: string;
  setupAuth?: SetupAuthFn;
}

/**
 * Record a demo using Playwright with narration-aware step timing.
 *
 * The recorder receives a pre-built NarrationManifest so it knows the exact
 * duration of each clip. When a step has `wait_for_narration`, the recorder
 * computes the remaining time for that clip and waits before executing.
 *
 * Narrate steps don't play audio — they record the video-relative offset
 * so the composer can place audio at the correct position later.
 */
export async function recordDemo(
  script: DemoScript,
  manifest: NarrationManifest,
  outDir: string,
  opts: RecordOptions,
): Promise<RecordingResult> {
  const { width, height } = script.output.resolution;
  const baseURL = opts.baseURL;
  const headless = opts.headless ?? true;

  // Authenticate in a separate hidden context so the login UI never appears
  // in the recording. storageState carries the session cookie into the
  // recording context so it starts pre-authenticated.
  let storageStatePath: string | undefined;
  if (script.auth?.role) {
    if (!opts.setupAuth) {
      throw new Error(
        `Script declares auth.role="${script.auth.role}" but no setupAuth callback was provided. ` +
          `Pass { setupAuth } to runDemoPipeline (or implement /api/demo-session and call it yourself).`,
      );
    }
    console.log(`  [recorder] bootstrapping auth for role "${script.auth.role}"...`);
    storageStatePath = await opts.setupAuth({
      role: script.auth.role,
      baseURL,
      headless,
    });
    console.log(`  [recorder] auth complete, storageState saved to ${storageStatePath}`);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: outDir, size: { width, height } },
    baseURL,
    ignoreHTTPSErrors: true,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });

  const cursor = script.cursor;
  if (cursor.enabled) {
    await installCursorOverlay(context, { showClickRipple: cursor.showClickRipple });
  }

  const page = await context.newPage();
  const timeline: NarrationTimeline = new Map();

  const clipStartTimes = new Map<string, number>();
  const recordingStartMs = Date.now();

  function elapsed(): number {
    return Date.now() - recordingStartMs;
  }

  try {
    // Initial navigation. Use "domcontentloaded" rather than "networkidle"
    // because long-poll/WebSocket connections (Convex, Firebase, etc.) keep
    // the network busy indefinitely.
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });

    if (cursor.enabled) {
      await injectCursorOverlay(page, { showClickRipple: cursor.showClickRipple });
      await primeCursorPosition(page);
    }

    const cursorOpts: CursorOptions = {
      travelMs: cursor.travelMs,
      steps: cursor.steps,
      showClickRipple: cursor.showClickRipple,
    };

    for (const scene of script.scenes) {
      console.log(`  [recorder] scene: ${scene.id}`);

      for (const step of scene.steps) {
        if (step.wait_for_narration) {
          const clipId = step.wait_for_narration;
          const startTime = clipStartTimes.get(clipId);
          const entry = manifest.get(clipId);

          if (startTime != null && entry) {
            const endTime = startTime + entry.durationMs;
            const remaining = endTime - elapsed();
            if (remaining > 0) {
              console.log(`    [recorder] waiting ${remaining}ms for narration "${clipId}"`);
              await page.waitForTimeout(remaining);
            }
          }
        }

        await executeStep(page, step, cursor.enabled ? cursorOpts : null);

        if (step.action === "narrate") {
          const offsetMs = elapsed();
          clipStartTimes.set(step.clip, offsetMs);
          timeline.set(step.clip, { videoOffsetMs: offsetMs });
          console.log(`    [recorder] narrate "${step.clip}" at ${offsetMs}ms`);
        }

        const waitAfter = step.wait_after ?? DEFAULT_WAIT_AFTER_MS;
        if (waitAfter > 0) {
          await page.waitForTimeout(waitAfter);
        }
      }
    }

    const totalDurationMs = elapsed();

    await context.close();
    await browser.close();

    const videoPath = await findRecordedVideo(outDir);

    return { videoPath, narrationTimeline: timeline, totalDurationMs };
  } catch (error) {
    await context.close();
    await browser.close();
    throw error;
  }
}

async function executeStep(
  page: import("@playwright/test").Page,
  step: DemoStep,
  cursorOpts: CursorOptions | null,
): Promise<void> {
  switch (step.action) {
    case "narrate":
      break;

    case "goto": {
      // Skip reload if already on the target pathname — avoids a white flash
      // and keeps cursor overlay continuous.
      const currentPath = new URL(page.url()).pathname.replace(/\/$/, "");
      const targetPath = step.value.startsWith("http")
        ? new URL(step.value).pathname.replace(/\/$/, "")
        : step.value.replace(/\/$/, "");
      if (currentPath === targetPath) break;
      await page.goto(step.value, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (cursorOpts) {
        await injectCursorOverlay(page, { showClickRipple: cursorOpts.showClickRipple });
        await primeCursorPosition(page);
      }
      break;
    }

    case "click": {
      const target = page.locator(step.selector).first();
      if (cursorOpts) await animateCursorTo(page, target, cursorOpts);
      await target.click({ timeout: 15_000 });
      break;
    }

    case "fill": {
      const target = page.locator(step.selector).first();
      if (cursorOpts) await animateCursorTo(page, target, cursorOpts);
      await target.fill(step.value, { timeout: 15_000 });
      break;
    }

    case "press":
      await page.keyboard.press(step.value);
      break;

    case "hover": {
      const target = page.locator(step.selector).first();
      if (cursorOpts) await animateCursorTo(page, target, cursorOpts);
      await target.hover({ timeout: 15_000 });
      break;
    }

    case "scroll": {
      const amount =
        step.value === "down" ? 500 : step.value === "up" ? -500 : parseInt(step.value, 10);
      await page.mouse.wheel(0, amount);
      break;
    }

    case "wait":
      switch (step.condition) {
        case "selector":
          if (step.selector) {
            await page.waitForSelector(step.selector, { timeout: step.timeout ?? 30_000 });
          }
          break;
        case "timeout":
          if (step.timeout) {
            await page.waitForTimeout(step.timeout);
          }
          break;
        case "networkidle":
          await page.waitForLoadState("networkidle", { timeout: step.timeout ?? 30_000 });
          break;
      }
      break;
  }
}

async function findRecordedVideo(dir: string): Promise<string> {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = readdirSync(dir).filter((f) => f.endsWith(".webm"));
  if (files.length === 0) {
    throw new Error(`No .webm video found in ${dir}`);
  }
  files.sort((a, b) => {
    const aTime = statSync(join(dir, a)).mtimeMs;
    const bTime = statSync(join(dir, b)).mtimeMs;
    return bTime - aTime;
  });
  const first = files[0];
  if (!first) throw new Error(`No .webm video found in ${dir}`);
  return join(dir, first);
}
