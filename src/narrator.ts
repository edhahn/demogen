import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoScript, NarrationManifest } from "./types.js";

function getTtsService(): string {
  return (process.env.DEMOGEN_TTS_SERVICE ?? process.env.DEMO_TTS_SERVICE ?? "say").toLowerCase();
}

/**
 * Pre-generate TTS audio for all narration clips in a demo script.
 *
 * Uses macOS `say` by default. Set DEMOGEN_TTS_SERVICE=elevenlabs (with
 * ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID) for higher-quality narration.
 * Caches by content hash — unchanged clips are not regenerated.
 */
export async function generateNarration(
  script: DemoScript,
  outDir: string,
): Promise<NarrationManifest> {
  mkdirSync(outDir, { recursive: true });

  const ttsService = getTtsService();
  const defaultVoice = script.narration.voice;
  const defaultRate = script.narration.rate;
  const manifest: NarrationManifest = new Map();

  for (const clip of script.narration.clips) {
    const voice = clip.voice ?? defaultVoice;
    const rate = clip.rate ?? defaultRate;
    const ext = ttsService === "elevenlabs" ? "mp3" : "wav";
    const audioPath = join(outDir, `${clip.id}.${ext}`);
    const hashPath = join(outDir, `${clip.id}.hash`);

    const contentHash = computeHash(`${ttsService}|${clip.text}|${voice}|${rate}`);

    if (existsSync(audioPath) && existsSync(hashPath)) {
      const existingHash = readFileSync(hashPath, "utf-8").trim();
      if (existingHash === contentHash) {
        const durationMs = probeAudioDuration(audioPath);
        manifest.set(clip.id, { audioPath, durationMs });
        console.log(`  [narrator] cached: ${clip.id} (${durationMs}ms)`);
        continue;
      }
    }

    if (ttsService === "elevenlabs") {
      await generateClipElevenLabs(clip.text, clip.voice, audioPath);
    } else {
      generateClipSay(clip.text, voice, rate, audioPath);
    }
    writeFileSync(hashPath, contentHash, "utf-8");

    const durationMs = probeAudioDuration(audioPath);
    manifest.set(clip.id, { audioPath, durationMs });
    console.log(`  [narrator] generated: ${clip.id} (${durationMs}ms)`);
  }

  return manifest;
}

function generateClipSay(text: string, voice: string, rate: number, outputPath: string): void {
  execFileSync(
    "say",
    ["-v", voice, "-r", String(rate), "-o", outputPath, "--data-format=LEI16@44100", text],
    { stdio: "pipe" },
  );
}

async function generateClipElevenLabs(
  text: string,
  voiceOverride: string | undefined,
  outputPath: string,
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = voiceOverride ?? process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not set (and no per-clip voice override)");

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`ElevenLabs API error ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

function probeAudioDuration(audioPath: string): number {
  const result = execFileSync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
    { encoding: "utf-8" },
  ).trim();
  return Math.round(parseFloat(result) * 1000);
}

function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function checkNarratorPrerequisites(): void {
  if (getTtsService() === "elevenlabs") {
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error(
        "ELEVENLABS_API_KEY is not set (required when DEMOGEN_TTS_SERVICE=elevenlabs)",
      );
    }
    if (!process.env.ELEVENLABS_VOICE_ID) {
      throw new Error(
        "ELEVENLABS_VOICE_ID is not set (required when DEMOGEN_TTS_SERVICE=elevenlabs)",
      );
    }
  } else {
    try {
      execFileSync("which", ["say"], { stdio: "pipe" });
    } catch {
      throw new Error(
        "macOS `say` command not found. Default TTS requires macOS, or set DEMOGEN_TTS_SERVICE=elevenlabs.",
      );
    }
  }
  try {
    execFileSync("which", ["ffprobe"], { stdio: "pipe" });
  } catch {
    throw new Error("ffprobe not found. Install ffmpeg: brew install ffmpeg");
  }
}
