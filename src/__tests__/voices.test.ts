import { describe, expect, it } from "vitest";
import { resolveVoice, type VoiceMap } from "../voices.js";

const voiceMap: VoiceMap = {
  default: "Samantha",
  kokoro: {
    Samantha: "af_heart",
    Daniel: "am_michael",
  },
};

describe("resolveVoice — kokoro", () => {
  it("resolves a friendly name to its Kokoro voice ID", () => {
    expect(resolveVoice(voiceMap, "kokoro", "Samantha")).toBe("af_heart");
    expect(resolveVoice(voiceMap, "kokoro", "Daniel")).toBe("am_michael");
  });

  it("falls back to the friendly name verbatim when unmapped", () => {
    expect(resolveVoice(voiceMap, "kokoro", "af_bella")).toBe("af_bella");
  });

  it("falls back to the friendly name when no kokoro block exists", () => {
    expect(resolveVoice({}, "kokoro", "af_heart")).toBe("af_heart");
  });
});
