#!/usr/bin/env node
/**
 * CLI entry point for demogen.
 *
 * Usage:
 *   demogen <path-to-yaml> [options]
 *
 * Run `demogen --help` for the full flag list.
 */

import { execFileSync } from "node:child_process";
import { loadDemogenEnv } from "./env.js";
import { runDemoPipeline } from "./runner.js";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: demogen <path-to-yaml> [options]

Options:
  --skip-narration       reuse existing narration clips
  --skip-composition     stop after recording the .webm
  --headed               run browser headed (visible)
  --base-url <url>       override the recording base URL
  --out-dir <path>       base dir for generated content (default: ./demos next to script)
  --interstitial-dir <p> override interstitial dir (default: <out-dir>/interstitial)
  --output-dir <path>    override final output dir (default: <out-dir>/output)
  --voices <path>        path to voices.yml (default: ./voices.yml in cwd)
  --env <path>           load env vars from this file (default: ./.env.demogen if present)
  --open                 open the output in the system default player when done

Env file:
  Before reading any DEMOGEN_* / *_API_KEY variables, demogen loads
  ./.env.demogen (or the path passed to --env) if it exists. Variables
  already set in the shell environment are preserved (not overridden).

Environment:
  DEMOGEN_BASE_URL          base URL (overrides yaml, overridden by --base-url)
  DEMOGEN_OUT_DIR           base dir for generated content
  DEMOGEN_INTERSTITIAL_DIR  override interstitial dir
  DEMOGEN_OUTPUT_DIR        override final output dir
  DEMOGEN_VOICES            path to voices.yml
  DEMOGEN_TTS_SERVICE       "say" (default, macOS) | "elevenlabs" | "openai"
  ELEVENLABS_API_KEY        required when DEMOGEN_TTS_SERVICE=elevenlabs
  ELEVENLABS_VOICE_ID       fallback voice when no voices.yml mapping exists
  OPENAI_API_KEY            required when DEMOGEN_TTS_SERVICE=openai
  OPENAI_VOICE              fallback voice (default: nova) — alloy|echo|fable|onyx|nova|shimmer
  OPENAI_TTS_MODEL          OpenAI model (default: tts-1; use tts-1-hd for higher quality)
`);
  process.exit(args.length === 0 ? 1 : 0);
}

const VALUE_FLAGS = [
  "--base-url",
  "--out-dir",
  "--interstitial-dir",
  "--output-dir",
  "--voices",
  "--env",
];

function flagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

function isFlagValue(arg: string): boolean {
  for (const flag of VALUE_FLAGS) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1] === arg) return true;
  }
  return false;
}

const scriptPath = args.find(
  (a) => !a.startsWith("--") && args.indexOf(a) === args.findIndex((x) => x === a) && !isFlagValue(a),
);

if (!scriptPath) {
  console.error("Error: missing path to YAML script");
  console.error("Run `demogen --help` for usage.");
  process.exit(1);
}

// Load env file BEFORE constructing opts so DEMOGEN_* vars used as defaults
// in runner/narrator are visible.
const loadedEnv = loadDemogenEnv(flagValue("--env"));
if (loadedEnv) console.log(`[env] loaded ${loadedEnv}`);

const opts = {
  skipNarration: args.includes("--skip-narration"),
  skipComposition: args.includes("--skip-composition"),
  headless: !args.includes("--headed"),
  baseURL: flagValue("--base-url"),
  outDir: flagValue("--out-dir"),
  interstitialDir: flagValue("--interstitial-dir"),
  outputDir: flagValue("--output-dir"),
  voicesPath: flagValue("--voices"),
};

const openAfter = args.includes("--open");

async function main() {
  const result = await runDemoPipeline(scriptPath as string, opts);
  console.log("\n=== Demo Recording Complete ===");
  console.log(`  Output: ${result.outputPath}`);
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Scenes: ${result.sceneCount}`);
  console.log(`  Narration clips: ${result.clipCount}`);
  if (openAfter) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      execFileSync(opener, [result.outputPath], { stdio: "ignore" });
    } catch {
      console.warn(`Could not open ${result.outputPath} with ${opener}`);
    }
  }
}

main().catch((err) => {
  console.error("\nDemo recording failed:", err);
  process.exit(1);
});
