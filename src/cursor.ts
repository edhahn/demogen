/**
 * Simulated cursor overlay for demo recordings.
 *
 * Two layers working together:
 *
 *  1. Browser overlay (installCursorOverlay) — injected via
 *     context.addInitScript so it runs on every navigation. Renders a
 *     pointer-events:none SVG arrow that tracks synthetic mousemove events,
 *     plus a click ripple spawned on mousedown. Captured natively by
 *     Playwright's recordVideo because it's a real DOM element.
 *
 *  2. Timed mouse travel (animateCursorTo) — Node-side interpolator that
 *     drives page.mouse.move across N steps with a small wait between frames,
 *     producing visible motion (Playwright's built-in {steps} option fires as
 *     fast as possible, which isn't readable on video).
 *
 * Assumes same-origin navigation — the overlay lives in the top frame only.
 */

import type { BrowserContext, Locator, Page } from "@playwright/test";

export interface CursorOptions {
  travelMs: number;
  steps: number;
  showClickRipple: boolean;
}

const cursorPositions = new WeakMap<Page, { x: number; y: number }>();

export async function installCursorOverlay(
  context: BrowserContext,
  opts: { showClickRipple: boolean },
): Promise<void> {
  await context.addInitScript({ content: buildOverlayScriptSource(opts) });
}

export async function injectCursorOverlay(
  page: Page,
  opts: { showClickRipple: boolean },
): Promise<void> {
  await page.evaluate(buildOverlayScriptSource(opts));
}

function buildOverlayScriptSource(opts: { showClickRipple: boolean }): string {
  const cfg = JSON.stringify({ showClickRipple: opts.showClickRipple });
  return `
(() => {
  var __cfg = ${cfg};
  var __w = window;
  if (__w.__demoEnsureCursor) { __w.__demoEnsureCursor(); return; }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var CURSOR_SIZE = 32;

  var style = document.createElement("style");
  style.textContent = [
    "#__demo-cursor{position:fixed;top:0;left:0;width:" + CURSOR_SIZE + "px;height:" + CURSOR_SIZE + "px;",
    "pointer-events:none;z-index:2147483647;transform:translate3d(-100px,-100px,0);transition:none;",
    "filter:drop-shadow(0 2px 4px rgba(0,0,0,0.55));will-change:transform;}",
    ".__demo-ripple{position:fixed;pointer-events:none;z-index:2147483646;width:60px;height:60px;",
    "margin-left:-30px;margin-top:-30px;border-radius:50%;border:3px solid #fbbf24;",
    "background:rgba(251,191,36,0.30);animation:__demo-ripple-anim 600ms ease-out forwards;}",
    "@keyframes __demo-ripple-anim{0%{transform:scale(0.2);opacity:1;}100%{transform:scale(2.2);opacity:0;}}"
  ].join("");

  function buildCursor() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", String(CURSOR_SIZE));
    svg.setAttribute("height", String(CURSOR_SIZE));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.id = "__demo-cursor";
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M3 2 L3 19 L8 14.5 L10.8 21 L13.6 19.7 L10.8 13.5 L17 13.5 Z");
    path.setAttribute("fill", "#fbbf24");
    path.setAttribute("stroke", "#111111");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  var liveCursor = null;
  var lastX = -100;
  var lastY = -100;

  function ensureCursor() {
    var root = document.documentElement;
    if (!root) return;
    if (!root.contains(style)) root.appendChild(style);
    if (!liveCursor || !root.contains(liveCursor)) {
      liveCursor = buildCursor();
      liveCursor.style.transform = "translate3d(" + lastX + "px," + lastY + "px,0)";
      root.appendChild(liveCursor);
    }
  }

  __w.__demoEnsureCursor = ensureCursor;

  function attach() {
    ensureCursor();

    window.addEventListener("mousemove", function (e) {
      lastX = e.clientX;
      lastY = e.clientY;
      ensureCursor();
      if (liveCursor) {
        liveCursor.style.transform = "translate3d(" + e.clientX + "px," + e.clientY + "px,0)";
      }
    }, { capture: true, passive: true });

    if (__cfg.showClickRipple) {
      window.addEventListener("mousedown", function (e) {
        var ripple = document.createElement("div");
        ripple.className = "__demo-ripple";
        ripple.style.left = e.clientX + "px";
        ripple.style.top = e.clientY + "px";
        (document.documentElement || document.body).appendChild(ripple);
        setTimeout(function () { ripple.remove(); }, 700);
      }, { capture: true, passive: true });
    }

    var obs = new MutationObserver(function () { ensureCursor(); });
    obs.observe(document.documentElement, { childList: true, subtree: false });
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: false });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();
`;
}

export async function primeCursorPosition(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const x = Math.floor((viewport?.width ?? 1280) / 2);
  const y = Math.floor((viewport?.height ?? 720) / 2);
  await page.mouse.move(x, y);
  cursorPositions.set(page, { x, y });
}

export async function animateCursorTo(
  page: Page,
  locator: Locator,
  opts: CursorOptions,
): Promise<void> {
  const box = await locator.boundingBox({ timeout: 10_000 });
  if (!box) return;

  const toX = Math.round(box.x + box.width / 2);
  const toY = Math.round(box.y + box.height / 2);

  const from = cursorPositions.get(page);
  if (!from) {
    await page.mouse.move(toX, toY);
    cursorPositions.set(page, { x: toX, y: toY });
    return;
  }

  const steps = Math.max(1, opts.steps);
  const frameMs = Math.max(0, Math.floor(opts.travelMs / steps));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const x = Math.round(from.x + (toX - from.x) * eased);
    const y = Math.round(from.y + (toY - from.y) * eased);
    await page.mouse.move(x, y);
    if (frameMs > 0 && i < steps) {
      await page.waitForTimeout(frameMs);
    }
  }
  cursorPositions.set(page, { x: toX, y: toY });
}
