/**
 * Scene transition registry.
 *
 * A transition describes how one video segment is joined to the segment before
 * it. Every transition maps to an ffmpeg `xfade` transition id (for blended
 * joins) or to `null` (a hard cut, joined by plain concat). This registry is
 * the single source of truth: the YAML schema derives its allowed values from
 * {@link transitionNames}, and the composer looks up the xfade id + default
 * duration here.
 *
 * Adding a new transition is a one-line change: add an entry below. ffmpeg's
 * xfade filter ships ~50 named transitions (slideleft, circleopen, dissolve,
 * pixelize, radial, …) so most additions are just exposing another id under a
 * friendly name.
 */
export interface TransitionDef {
  /**
   * ffmpeg `xfade` transition id, or `null` for a hard cut (no blend — the
   * segments are concatenated back-to-back).
   */
  xfade: string | null;
  /** Duration (ms) used when a scene doesn't set `transition_duration`. */
  defaultDurationMs: number;
  /** One-line human description. */
  description: string;
}

export const TRANSITIONS = {
  /** Hard cut — no blend. Default; preserves the fast stream-copy concat path. */
  cut: { xfade: null, defaultDurationMs: 0, description: "Hard cut, no blend" },
  /** Alias for {@link cut}. */
  none: { xfade: null, defaultDurationMs: 0, description: "Alias for cut" },
  /** Dissolve directly from the outgoing scene into the incoming one. */
  crossfade: { xfade: "fade", defaultDurationMs: 500, description: "Crossfade / dissolve between scenes" },
  /** Legacy alias for {@link crossfade} (the original `fade` enum value). */
  fade: { xfade: "fade", defaultDurationMs: 500, description: "Alias for crossfade" },
  /** Fade the outgoing scene out to black, then the incoming scene in. */
  fade_black: { xfade: "fadeblack", defaultDurationMs: 600, description: "Fade out to black, then in" },
  /** Fade the outgoing scene out to white, then the incoming scene in. */
  fade_white: { xfade: "fadewhite", defaultDurationMs: 600, description: "Fade out to white, then in" },
  /** Wipe the incoming scene across the frame (right-to-left by default). */
  wipe: { xfade: "wipeleft", defaultDurationMs: 600, description: "Wipe from right to left" },
} as const satisfies Record<string, TransitionDef>;

export type TransitionName = keyof typeof TRANSITIONS;

/** All registered transition names, for building the zod enum. */
export const transitionNames = Object.keys(TRANSITIONS) as [TransitionName, ...TransitionName[]];

/** Look up a transition definition. Throws on an unknown name (schema guards inputs). */
export function resolveTransition(name: string): TransitionDef {
  const def = (TRANSITIONS as Record<string, TransitionDef>)[name];
  if (!def) {
    throw new Error(`Unknown transition "${name}". Known: ${transitionNames.join(", ")}`);
  }
  return def;
}

/** True when the transition is a hard cut (no xfade blend needed). */
export function isHardCut(name: string): boolean {
  return resolveTransition(name).xfade === null;
}

/**
 * Effective blend duration (ms) for a scene: its explicit `transition_duration`
 * if set, otherwise the transition's registered default.
 */
export function transitionDurationMs(name: string, explicitMs?: number): number {
  if (explicitMs != null) return explicitMs;
  return resolveTransition(name).defaultDurationMs;
}
