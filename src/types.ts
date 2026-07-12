import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { transitionNames } from "./transitions.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const narrationClipSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Clip IDs must be snake_case"),
  text: z.string().min(1),
  voice: z.string().optional(),
  rate: z.number().positive().optional(),
});

const narrationConfigSchema = z.object({
  /**
   * Friendly voice name. If omitted, falls back to the `default:` entry in
   * voices.yml, then to "Samantha". Per-clip `voice` overrides this.
   */
  voice: z.string().optional(),
  rate: z.number().positive().default(175),
  clips: z.array(narrationClipSchema).min(1),
});

const baseStepFields = z.object({
  wait_after: z.number().nonnegative().optional(),
  wait_for_narration: z.string().optional(),
  description: z.string().optional(),
});

const narrateStepSchema = baseStepFields.extend({
  action: z.literal("narrate"),
  clip: z.string(),
});

const gotoStepSchema = baseStepFields.extend({
  action: z.literal("goto"),
  value: z.string(),
});

const clickStepSchema = baseStepFields.extend({
  action: z.literal("click"),
  selector: z.string(),
});

const fillStepSchema = baseStepFields.extend({
  action: z.literal("fill"),
  selector: z.string(),
  value: z.string(),
});

const pressStepSchema = baseStepFields.extend({
  action: z.literal("press"),
  value: z.string(),
});

const hoverStepSchema = baseStepFields.extend({
  action: z.literal("hover"),
  selector: z.string(),
});

const scrollStepSchema = baseStepFields.extend({
  action: z.literal("scroll"),
  value: z.string(),
});

const waitStepSchema = baseStepFields.extend({
  action: z.literal("wait"),
  condition: z.enum(["selector", "timeout", "networkidle"]),
  selector: z.string().optional(),
  timeout: z.number().positive().optional(),
});

const demoStepSchema = z.discriminatedUnion("action", [
  narrateStepSchema,
  gotoStepSchema,
  clickStepSchema,
  fillStepSchema,
  pressStepSchema,
  hoverStepSchema,
  scrollStepSchema,
  waitStepSchema,
]);

const browserSceneSchema = z.object({
  /**
   * Scene kind discriminant. Optional and defaults to "browser" so scripts
   * written before card scenes existed continue to parse unchanged.
   */
  type: z.literal("browser").optional(),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Scene IDs must be snake_case"),
  title: z.string().optional(),
  /**
   * How this scene is joined to the segment before it. See the transition
   * registry (transitions.ts) for the full list. Defaults to a hard `cut`,
   * which preserves the fast stream-copy concat path. Blended transitions
   * (crossfade, fade_black, fade_white, wipe, …) are rendered with ffmpeg's
   * xfade filter at compose time.
   */
  transition: z.enum(transitionNames).default("cut"),
  /**
   * Blend duration in ms. When omitted, the transition's registered default is
   * used. Ignored for `cut`/`none`.
   */
  transition_duration: z.number().nonnegative().optional(),
  steps: z.array(demoStepSchema).min(1),
});

/**
 * A non-browser "slate" scene rendered from styled HTML (title/ending/credits).
 * Can appear anywhere in the `scenes` list; contiguous browser scenes on either
 * side are recorded separately and concatenated around the card.
 */
const cardSceneSchema = z.object({
  type: z.literal("card"),
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Scene IDs must be snake_case"),
  /** Drives default styling/semantics only — any card may set any field. */
  kind: z.enum(["title", "ending", "credits"]).default("title"),
  headline: z.string().min(1),
  subtitle: z.string().optional(),
  /** Stacked lines, intended for credits but allowed on any card. */
  lines: z.array(z.string()).optional(),
  /** CSS color or gradient for the card background. */
  background: z.string().optional(),
  /**
   * Minimum time the card holds on screen. The card actually shows for
   * max(duration_ms, narration clip duration + tail padding).
   */
  duration_ms: z.number().positive().default(4000),
  /** Optional narration clip id (from the shared narration pool) to voice over the card. */
  clip: z.string().optional(),
  /**
   * Fade the card in from / out to black within its own segment. Independent of
   * `transition` (which blends the card with adjacent segments at concat time).
   * When you set a blended `transition` into or out of a card, set `fade: false`
   * on that card to avoid stacking two fades at the same boundary.
   */
  fade: z.boolean().default(true),
  /** How this card is joined to the segment before it. See transitions.ts. */
  transition: z.enum(transitionNames).default("cut"),
  /** Blend duration in ms; falls back to the transition's registered default. */
  transition_duration: z.number().nonnegative().optional(),
});

/**
 * A scene is either a browser recording (default) or a rendered card. Card is
 * listed first so its `type: "card"` discriminant is matched before the browser
 * variant, which accepts a missing/`"browser"` type.
 */
const demoSceneSchema = z.union([cardSceneSchema, browserSceneSchema]);

const musicConfigSchema = z.object({
  /** Audio file, resolved relative to the demo script's directory. */
  path: z.string().min(1),
  /** Mix gain 0..1 applied to the music bed (default 0.15). */
  volume: z.number().gt(0).max(1).default(0.15),
  fade_in_ms: z.number().nonnegative().optional(),
  fade_out_ms: z.number().nonnegative().optional(),
});

const outputSettingsSchema = z.object({
  resolution: z
    .object({
      width: z.number().positive().default(1280),
      height: z.number().positive().default(720),
    })
    .default({ width: 1280, height: 720 }),
  fps: z.number().positive().default(30),
  quality: z.enum(["high", "medium"]).default("high"),
  format: z.literal("mp4").default("mp4"),
});

const cursorConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    travelMs: z.number().positive().default(500),
    steps: z.number().int().positive().default(15),
    showClickRipple: z.boolean().default(true),
  })
  .default({});

const demoMetaSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "Demo names must be kebab-case"),
  description: z.string(),
  feature: z.string().optional(),
  author: z.string().optional(),
  created: z.string().optional(),
});

const demoAuthSchema = z
  .object({
    /**
     * Free-form role identifier. The recording pipeline does NOT interpret
     * this value — it is forwarded to the user-supplied `setupAuth` callback
     * (see RunOptions) which is responsible for producing a Playwright
     * storageState file pre-authenticated for this role.
     */
    role: z.string().optional(),
  })
  .optional();

const baseUrlSchema = z.string().url().optional();

export const demoScriptSchema = z
  .object({
    meta: demoMetaSchema,
    auth: demoAuthSchema,
    /**
     * Base URL the recorder navigates against. Overridden by RunOptions.baseURL
     * or the DEMOGEN_BASE_URL environment variable.
     */
    base_url: baseUrlSchema,
    output: outputSettingsSchema.default({}),
    cursor: cursorConfigSchema,
    narration: narrationConfigSchema,
    /** Optional background music mixed under the entire video. */
    music: musicConfigSchema.optional(),
    scenes: z.array(demoSceneSchema).min(1),
  })
  .superRefine((script, ctx) => {
    const clipIds = new Set(script.narration.clips.map((c) => c.id));

    for (const scene of script.scenes) {
      if (scene.type === "card") {
        if (scene.clip && !clipIds.has(scene.clip)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Card scene "${scene.id}" references unknown narration clip "${scene.clip}"`,
            path: ["scenes"],
          });
        }
        continue;
      }

      for (const step of scene.steps) {
        if (step.action === "narrate" && !clipIds.has(step.clip)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Scene "${scene.id}" references unknown narration clip "${step.clip}"`,
            path: ["scenes"],
          });
        }
        if (step.wait_for_narration && !clipIds.has(step.wait_for_narration)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Scene "${scene.id}" wait_for_narration references unknown clip "${step.wait_for_narration}"`,
            path: ["scenes"],
          });
        }
        if (step.action === "wait") {
          if (step.condition === "selector" && !step.selector) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Scene "${scene.id}" wait step with condition "selector" requires a selector field`,
              path: ["scenes"],
            });
          }
          if (step.condition === "timeout" && step.timeout == null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Scene "${scene.id}" wait step with condition "timeout" requires a timeout field`,
              path: ["scenes"],
            });
          }
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type DemoScript = z.infer<typeof demoScriptSchema>;
export type DemoScene = z.infer<typeof demoSceneSchema>;
export type BrowserScene = z.infer<typeof browserSceneSchema>;
export type DemoCardScene = z.infer<typeof cardSceneSchema>;
export type MusicConfig = z.infer<typeof musicConfigSchema>;
export type DemoStep = z.infer<typeof demoStepSchema>;
export type NarrationClip = z.infer<typeof narrationClipSchema>;
export type OutputSettings = z.infer<typeof outputSettingsSchema>;
export type CursorConfig = z.infer<typeof cursorConfigSchema>;
export type DemoMeta = z.infer<typeof demoMetaSchema>;

// ---------------------------------------------------------------------------
// Runtime types (not in YAML — produced by pipeline stages)
// ---------------------------------------------------------------------------

export interface NarrationManifestEntry {
  audioPath: string;
  durationMs: number;
}

export type NarrationManifest = Map<string, NarrationManifestEntry>;

export interface NarrationTimelineEntry {
  videoOffsetMs: number;
}

export type NarrationTimeline = Map<string, NarrationTimelineEntry>;

/** Where a browser scene begins within the continuous run recording. */
export interface SceneBoundary {
  sceneId: string;
  /** Offset (ms) from the start of this run's recording where the scene begins. */
  startMs: number;
}

export interface RecordingResult {
  videoPath: string;
  narrationTimeline: NarrationTimeline;
  totalDurationMs: number;
  /**
   * Per-scene start offsets within the run recording, in scene order. Lets the
   * runner split one continuous recording into per-scene segments so scene-level
   * transitions can be applied without breaking session/navigation continuity.
   */
  sceneBoundaries: SceneBoundary[];
}

export interface ComposeOptions {
  videoPath: string;
  manifest: NarrationManifest;
  timeline: NarrationTimeline;
  output: OutputSettings;
  outputPath: string;
}

export interface PipelineResult {
  outputPath: string;
  durationMs: number;
  clipCount: number;
  sceneCount: number;
  cardCount: number;
}

/**
 * Callback that produces a Playwright storageState file for a given auth
 * role. Called by the recorder before the recording context is created so
 * the demo starts already authenticated. Return the absolute path to a
 * storageState JSON file (e.g., one written via context.storageState({path})).
 *
 * If your demo doesn't need auth, omit `auth.role` from the script and skip
 * this callback entirely.
 */
export type SetupAuthFn = (params: {
  role: string;
  baseURL: string;
  headless: boolean;
}) => Promise<string>;

export interface RunOptions {
  skipNarration?: boolean;
  skipComposition?: boolean;
  headless?: boolean;
  /**
   * Base URL passed to Playwright. Overrides `base_url` from the YAML script
   * and the `DEMOGEN_BASE_URL` env var.
   */
  baseURL?: string;
  /**
   * Base directory for all generated content. Subdirectories `interstitial/`
   * (with `narration/` and `recordings/` underneath) and `output/` are
   * created here. Defaults to `./demos` next to the script file. Per-purpose
   * overrides take precedence: see `interstitialDir` and `outputDir`.
   */
  outDir?: string;
  /**
   * Override for the interstitial directory (narration clips + raw .webm).
   * Defaults to `<outDir>/interstitial`. Also overridable via the
   * `DEMOGEN_INTERSTITIAL_DIR` env var.
   */
  interstitialDir?: string;
  /**
   * Override for the final-output directory. Defaults to `<outDir>/output`.
   * Also overridable via the `DEMOGEN_OUTPUT_DIR` env var.
   */
  outputDir?: string;
  /**
   * Path to a voices.yml file mapping friendly voice names (e.g. "Samantha")
   * to service-specific voice IDs. Defaults to env `DEMOGEN_VOICES`, then
   * `./voices.yml` in the current working directory.
   */
  voicesPath?: string;
  /**
   * Path to a `.env` file to load before reading DEMOGEN_* / *_API_KEY
   * variables. Existing shell env values are preserved (not overridden).
   * Defaults to `./.env.demogen` in the current working directory if it
   * exists; pass an explicit path to force a different file (missing file
   * raises an error in that case).
   */
  envPath?: string;
  /** Auth bootstrap callback. Required when the script declares `auth.role`. */
  setupAuth?: SetupAuthFn;
}

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

export function parseDemoScript(yamlPath: string): DemoScript {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  return demoScriptSchema.parse(parsed);
}
