import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

export type TtsService = "say" | "elevenlabs" | "openai" | "kokoro";

const voiceMapSchema = z
  .object({
    /**
     * Friendly voice name used when neither the script's `narration.voice`
     * nor a clip's `voice` is set. Must reference a name defined in one of
     * the per-service blocks (or be a literal voice ID / `say` voice name).
     */
    default: z.string().optional(),
    say: z.record(z.string()).optional(),
    elevenlabs: z.record(z.string()).optional(),
    openai: z.record(z.string()).optional(),
    kokoro: z.record(z.string()).optional(),
  })
  .partial();

export type VoiceMap = z.infer<typeof voiceMapSchema>;

/**
 * Load a voices.yml file mapping friendly voice names (e.g. "Samantha") to
 * service-specific voice IDs. Search order:
 *   1. explicit path argument
 *   2. DEMOGEN_VOICES env var
 *   3. ./voices.yml (or .yaml) in the current working directory
 *
 * Returns an empty map if no file is found — callers fall back to using the
 * raw voice name verbatim.
 */
export function loadVoiceMap(explicitPath?: string): VoiceMap {
  const candidates = [
    explicitPath,
    process.env.DEMOGEN_VOICES,
    join(process.cwd(), "voices.yml"),
    join(process.cwd(), "voices.yaml"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw);
    return voiceMapSchema.parse(parsed ?? {});
  }
  return {};
}

/**
 * Resolve a friendly voice name to the service-specific identifier. If the
 * voice is not present in the map, returns the friendly name unchanged so
 * macOS `say` (which uses voice names directly) and explicit voice IDs in
 * scripts continue to work.
 */
export function resolveVoice(
  map: VoiceMap,
  service: TtsService,
  friendlyName: string,
): string {
  const serviceMap = map[service];
  const mapped = serviceMap?.[friendlyName];
  return mapped ?? friendlyName;
}
