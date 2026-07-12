export {
  composeDemoVideo,
  concatSegments,
  mixBackgroundMusic,
  checkComposerPrerequisites,
} from "./composer.js";
export { buildCardHtml, cardDurationMs, composeCardSegment, renderCardImage } from "./cards.js";
export {
  generateNarration,
  checkNarratorPrerequisites,
} from "./narrator.js";
export { recordDemo } from "./recorder.js";
export { runDemoPipeline } from "./runner.js";
export { loadEnvFile, loadDemogenEnv } from "./env.js";
export {
  animateCursorTo,
  injectCursorOverlay,
  installCursorOverlay,
  primeCursorPosition,
} from "./cursor.js";
export type { CursorOptions } from "./cursor.js";
export {
  demoScriptSchema,
  parseDemoScript,
} from "./types.js";
export type {
  BrowserScene,
  ComposeOptions,
  CursorConfig,
  DemoCardScene,
  DemoMeta,
  DemoScene,
  DemoScript,
  DemoStep,
  MusicConfig,
  NarrationClip,
  NarrationManifest,
  NarrationManifestEntry,
  NarrationTimeline,
  NarrationTimelineEntry,
  OutputSettings,
  PipelineResult,
  RecordingResult,
  RunOptions,
  SetupAuthFn,
} from "./types.js";
