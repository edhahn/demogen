import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadVoiceMap, resolveVoice, type TtsService } from "./voices.js";
import type { DemoScript, NarrationManifest } from "./types.js";

function getTtsService(): TtsService {
  const raw = (process.env.DEMOGEN_TTS_SERVICE ?? process.env.DEMO_TTS_SERVICE ?? "say").toLowerCase();
  if (raw !== "say" && raw !== "elevenlabs" && raw !== "openai" && raw !== "kokoro") {
    throw new Error(
      `Unknown DEMOGEN_TTS_SERVICE "${raw}". Supported: say, elevenlabs, openai, kokoro.`,
    );
  }
  return raw;
}

/**
 * Pre-generate TTS audio for all narration clips in a demo script.
 *
 * Service is selected via DEMOGEN_TTS_SERVICE: "say" (macOS, default),
 * "elevenlabs", "openai", or "kokoro" (local Kokoro-FastAPI server).
 * Friendly voice names (e.g. "Samantha") are
 * resolved to service-specific voice IDs via voices.yml when present.
 * Caches by content hash — unchanged clips are not regenerated.
 */
export async function generateNarration(
  script: DemoScript,
  outDir: string,
  voicesPath?: string,
): Promise<NarrationManifest> {
  mkdirSync(outDir, { recursive: true });

  const ttsService = getTtsService();
  const voiceMap = loadVoiceMap(voicesPath);
  const defaultVoice = script.narration.voice ?? voiceMap.default ?? "Samantha";
  const defaultRate = script.narration.rate;
  const manifest: NarrationManifest = new Map();

  for (const clip of script.narration.clips) {
    const friendlyVoice = clip.voice ?? defaultVoice;
    const resolvedVoice = resolveVoice(voiceMap, ttsService, friendlyVoice);
    const rate = clip.rate ?? defaultRate;
    const ext = ttsService === "say" ? "wav" : "mp3";
    const audioPath = join(outDir, `${clip.id}.${ext}`);
    const hashPath = join(outDir, `${clip.id}.hash`);

    const contentHash = computeHash(`${ttsService}|${clip.text}|${resolvedVoice}|${rate}`);

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
      await generateClipElevenLabs(clip.text, resolvedVoice, audioPath);
    } else if (ttsService === "openai") {
      await generateClipOpenAI(clip.text, resolvedVoice, audioPath);
    } else if (ttsService === "kokoro") {
      await generateClipKokoro(clip.text, resolvedVoice, audioPath);
    } else {
      generateClipSay(clip.text, resolvedVoice, rate, audioPath);
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
  voiceId: string | undefined,
  outputPath: string,
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const resolvedVoiceId = voiceId ?? process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  if (!resolvedVoiceId) {
    throw new Error(
      "No ElevenLabs voice ID. Map the voice name in voices.yml or set ELEVENLABS_VOICE_ID.",
    );
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}`, {
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

async function generateClipOpenAI(
  text: string,
  voice: string | undefined,
  outputPath: string,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const resolvedVoice = voice ?? process.env.OPENAI_VOICE ?? "nova";
  const model = process.env.OPENAI_TTS_MODEL ?? "tts-1";

  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: resolvedVoice,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`OpenAI TTS API error ${response.status}: ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
}

async function generateClipKokoro(
  text: string,
  voice: string | undefined,
  outputPath: string,
): Promise<void> {
  const baseUrl = (process.env.KOKORO_BASE_URL ?? "http://localhost:8880/v1").replace(/\/$/, "");
  const resolvedVoice = voice ?? process.env.KOKORO_VOICE ?? "af_heart";
  const model = process.env.KOKORO_MODEL ?? "kokoro";
  const apiKey = process.env.KOKORO_API_KEY;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "audio/mpeg",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: text,
        voice: resolvedVoice,
        response_format: "mp3",
      }),
    });
  } catch (cause) {
    throw new Error(
      `Kokoro server not reachable at ${baseUrl} — is Kokoro-FastAPI running? ` +
        `Set KOKORO_BASE_URL to point at it.`,
      { cause },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Kokoro TTS API error ${response.status}: ${body}`);
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
  const service = getTtsService();
  if (service === "elevenlabs") {
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error(
        "ELEVENLABS_API_KEY is not set (required when DEMOGEN_TTS_SERVICE=elevenlabs)",
      );
    }
  } else if (service === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set (required when DEMOGEN_TTS_SERVICE=openai)",
      );
    }
  } else if (service === "kokoro") {
    const baseUrl = process.env.KOKORO_BASE_URL;
    if (baseUrl) {
      try {
        new URL(baseUrl);
      } catch {
        throw new Error(`KOKORO_BASE_URL is not a valid URL: "${baseUrl}"`);
      }
    }
    // No secret required — Kokoro-FastAPI runs locally. Connection errors
    // surface with a clear message from generateClipKokoro at generation time.
  } else {
    try {
      execFileSync("which", ["say"], { stdio: "pipe" });
    } catch {
      throw new Error(
        "macOS `say` command not found. Default TTS requires macOS, or set DEMOGEN_TTS_SERVICE to elevenlabs or openai.",
      );
    }
  }
  try {
    execFileSync("which", ["ffprobe"], { stdio: "pipe" });
  } catch {
    throw new Error("ffprobe not found. Install ffmpeg: brew install ffmpeg");
  }
}
