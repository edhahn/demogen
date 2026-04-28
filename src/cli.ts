#!/usr/bin/env node
/**
 * CLI entry point for demogen.
 *
 * Usage:
 *   demogen <path-to-yaml> [options]
 *
 * Options:
 *   --skip-narration       reuse existing narration clips
 *   --skip-composition     stop after recording the .webm
 *   --headed               run browser headed (visible)
 *   --base-url <url>       override the recording base URL
 *   --out-dir <path>       override the output directory root
 *   --open                 open the output in the system default player when done
 *
 * Examples:
 *   demogen ./scripts/smoke.demo.yaml
 *   demogen ./scripts/smoke.demo.yaml --headed --base-url http://localhost:5173
 */

import { execFileSync } from "node:child_process";
import { runDemoPipeline } from "./runner.js";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: demogen <path-to-yaml> [options]

Options:
  --skip-narration       reuse existing narration clips
  --skip-composition     stop after recording the .webm
  --headed               run browser headed (visible)
  --base-url <url>       override the recording base URL
  --out-dir <path>       override the output directory root
  --open                 open the output in the system default player when done

Environment:
  DEMOGEN_BASE_URL          base URL (overrides yaml, overridden by --base-url)
  DEMOGEN_TTS_SERVICE       "say" (default, macOS) | "elevenlabs"
  ELEVENLABS_API_KEY        required when DEMOGEN_TTS_SERVICE=elevenlabs
  ELEVENLABS_VOICE_ID       required when DEMOGEN_TTS_SERVICE=elevenlabs
`);
  process.exit(args.length === 0 ? 1 : 0);
}

function flagValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

const scriptPath = args.find((a) => !a.startsWith("--") && args.indexOf(a) === args.findIndex((x) => x === a) && !isFlagValue(a));

function isFlagValue(arg: string): boolean {
  // True if this arg is the value following a flag that takes a value.
  const valueFlags = ["--base-url", "--out-dir"];
  for (const flag of valueFlags) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1] === arg) return true;
  }
  return false;
}

if (!scriptPath) {
  console.error("Error: missing path to YAML script");
  console.error("Run `demogen --help` for usage.");
  process.exit(1);
}

const opts = {
  skipNarration: args.includes("--skip-narration"),
  skipComposition: args.includes("--skip-composition"),
  headless: !args.includes("--headed"),
  baseURL: flagValue("--base-url"),
  outDir: flagValue("--out-dir"),
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
