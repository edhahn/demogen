import { describe, expect, it } from "vitest";
import { clusterByCuts, planXfadeChain, type TransitionItem } from "../composer.js";
import {
  isHardCut,
  resolveTransition,
  TRANSITIONS,
  transitionDurationMs,
  transitionNames,
} from "../transitions.js";

describe("transition registry", () => {
  it("maps the requested transitions to xfade ids", () => {
    expect(resolveTransition("crossfade").xfade).toBe("fade");
    expect(resolveTransition("fade_black").xfade).toBe("fadeblack");
    expect(resolveTransition("fade_white").xfade).toBe("fadewhite");
    expect(resolveTransition("wipe").xfade).toBe("wipeleft");
  });

  it("treats cut and none as hard cuts, blends as non-cut", () => {
    expect(isHardCut("cut")).toBe(true);
    expect(isHardCut("none")).toBe(true);
    expect(isHardCut("crossfade")).toBe(false);
    expect(isHardCut("wipe")).toBe(false);
  });

  it("throws on an unknown transition", () => {
    expect(() => resolveTransition("swirl")).toThrow(/Unknown transition/);
  });

  it("uses the explicit duration when provided, else the registered default", () => {
    expect(transitionDurationMs("crossfade")).toBe(TRANSITIONS.crossfade.defaultDurationMs);
    expect(transitionDurationMs("crossfade", 1200)).toBe(1200);
    expect(transitionDurationMs("cut")).toBe(0);
  });

  it("exposes every registry key to the schema", () => {
    expect(transitionNames).toEqual(Object.keys(TRANSITIONS));
    expect(transitionNames).toContain("crossfade");
  });
});

describe("clusterByCuts", () => {
  const item = (path: string, transition: string, transitionDurationMs?: number): TransitionItem => ({
    path,
    transition,
    ...(transitionDurationMs != null ? { transitionDurationMs } : {}),
  });

  it("collapses an all-cut list into one cluster", () => {
    const clusters = clusterByCuts([
      item("a.mp4", "cut"),
      item("b.mp4", "cut"),
      item("c.mp4", "none"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.paths).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
  });

  it("starts a new cluster at each blended transition", () => {
    const clusters = clusterByCuts([
      item("a.mp4", "cut"),
      item("b.mp4", "crossfade"),
      item("c.mp4", "cut"),
      item("d.mp4", "fade_black"),
    ]);
    expect(clusters.map((c) => c.paths)).toEqual([["a.mp4"], ["b.mp4", "c.mp4"], ["d.mp4"]]);
    expect(clusters[1]?.transition).toBe("crossfade");
    expect(clusters[2]?.transition).toBe("fade_black");
  });

  it("treats a zero-duration blend as a hard cut", () => {
    const clusters = clusterByCuts([item("a.mp4", "cut"), item("b.mp4", "crossfade", 0)]);
    expect(clusters).toHaveLength(1);
  });
});

describe("planXfadeChain", () => {
  it("builds an xfade + acrossfade chain with cumulative offsets", () => {
    const { filterComplex, vOut, aOut } = planXfadeChain([
      { durationSec: 10, transition: "cut" },
      { durationSec: 8, transition: "crossfade", durationOverrideSec: 1 },
      { durationSec: 6, transition: "wipe", durationOverrideSec: 1 },
    ]);
    expect(vOut).toBe("[vout]");
    expect(aOut).toBe("[aout]");
    // First blend: offset = 10 - 1 = 9. Chains from raw inputs.
    expect(filterComplex).toContain("[0:v][1:v]xfade=transition=fade:duration=1.000:offset=9.000[vx1]");
    expect(filterComplex).toContain("[0:a][1:a]acrossfade=d=1.000[ax1]");
    // Second blend: running = 10 + 8 - 1 = 17, offset = 17 - 1 = 16, into final labels.
    expect(filterComplex).toContain("[vx1][2:v]xfade=transition=wipeleft:duration=1.000:offset=16.000[vout]");
    expect(filterComplex).toContain("[ax1][2:a]acrossfade=d=1.000[aout]");
  });

  it("clamps the blend duration to fit the shorter side", () => {
    const { filterComplex } = planXfadeChain([
      { durationSec: 0.5, transition: "cut" },
      { durationSec: 3, transition: "crossfade", durationOverrideSec: 2 },
    ]);
    // Left stream is only 0.5s, so the 2s blend clamps to 0.45s (0.5 - 0.05 margin).
    expect(filterComplex).toContain("duration=0.450");
    expect(filterComplex).toContain("offset=0.050");
  });

  it("requires at least two clusters", () => {
    expect(() => planXfadeChain([{ durationSec: 5, transition: "cut" }])).toThrow(/at least 2/);
  });
});
