export {
  composeDemoVideo,
  checkComposerPrerequisites,
} from "./composer.js";
export {
  generateNarration,
  checkNarratorPrerequisites,
} from "./narrator.js";
export { recordDemo } from "./recorder.js";
export { runDemoPipeline } from "./runner.js";
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
  ComposeOptions,
  CursorConfig,
  DemoMeta,
  DemoScene,
  DemoScript,
  DemoStep,
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
