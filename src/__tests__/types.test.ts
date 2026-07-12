import { describe, expect, it } from "vitest";
import { demoScriptSchema } from "../types.js";

const validScript = {
  meta: {
    name: "test-demo",
    description: "A test demo",
  },
  narration: {
    voice: "Samantha",
    rate: 175,
    clips: [
      { id: "welcome", text: "Welcome to the demo." },
      { id: "click_btn", text: "Now we click the button." },
    ],
  },
  scenes: [
    {
      id: "intro",
      steps: [
        { action: "narrate", clip: "welcome", wait_after: 500 },
        { action: "goto", value: "/home", wait_for_narration: "welcome" },
        { action: "narrate", clip: "click_btn" },
        {
          action: "click",
          selector: "#btn",
          wait_for_narration: "click_btn",
          wait_after: 1000,
        },
      ],
    },
  ],
};

describe("demoScriptSchema", () => {
  it("parses a valid script", () => {
    const result = demoScriptSchema.parse(validScript);
    expect(result.meta.name).toBe("test-demo");
    expect(result.narration.clips).toHaveLength(2);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]?.steps).toHaveLength(4);
  });

  it("applies defaults for output settings", () => {
    const result = demoScriptSchema.parse(validScript);
    expect(result.output.resolution.width).toBe(1280);
    expect(result.output.resolution.height).toBe(720);
    expect(result.output.fps).toBe(30);
    expect(result.output.quality).toBe("high");
  });

  it("applies default transition", () => {
    const result = demoScriptSchema.parse(validScript);
    expect(result.scenes[0]?.transition).toBe("cut");
  });

  it("rejects invalid demo name (not kebab-case)", () => {
    const bad = { ...validScript, meta: { ...validScript.meta, name: "Bad Name" } };
    expect(() => demoScriptSchema.parse(bad)).toThrow("kebab-case");
  });

  it("rejects invalid scene ID (not snake_case)", () => {
    const bad = {
      ...validScript,
      scenes: [{ ...validScript.scenes[0], id: "Bad-Scene" }],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("snake_case");
  });

  it("rejects invalid clip ID (not snake_case)", () => {
    const bad = {
      ...validScript,
      narration: {
        ...validScript.narration,
        clips: [{ id: "Bad-Clip", text: "hi" }],
      },
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("snake_case");
  });

  it("rejects narrate step referencing unknown clip", () => {
    const bad = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [{ action: "narrate", clip: "nonexistent" }],
        },
      ],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("nonexistent");
  });

  it("rejects wait_for_narration referencing unknown clip", () => {
    const bad = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [{ action: "goto", value: "/home", wait_for_narration: "missing" }],
        },
      ],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("missing");
  });

  it("rejects empty scenes array", () => {
    const bad = { ...validScript, scenes: [] };
    expect(() => demoScriptSchema.parse(bad)).toThrow();
  });

  it("rejects empty steps array", () => {
    const bad = {
      ...validScript,
      scenes: [{ id: "intro", steps: [] }],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow();
  });

  it("validates wait step with condition", () => {
    const script = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [
            { action: "narrate", clip: "welcome" },
            { action: "wait", condition: "selector", selector: "#done", timeout: 5000 },
          ],
        },
      ],
    };
    const result = demoScriptSchema.parse(script);
    const waitStep = result.scenes[0]?.steps[1];
    expect(waitStep?.action).toBe("wait");
    if (waitStep?.action === "wait") {
      expect(waitStep.condition).toBe("selector");
    }
  });

  it("parses all step action types", () => {
    const script = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [
            { action: "narrate", clip: "welcome" },
            { action: "goto", value: "/page" },
            { action: "click", selector: "#btn" },
            { action: "fill", selector: "#input", value: "hello" },
            { action: "press", value: "Enter" },
            { action: "hover", selector: "#menu" },
            { action: "scroll", value: "down" },
            { action: "wait", condition: "timeout", timeout: 1000 },
          ],
        },
      ],
    };
    const result = demoScriptSchema.parse(script);
    expect(result.scenes[0]?.steps).toHaveLength(8);
  });

  it("rejects wait condition=selector without selector field", () => {
    const bad = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [
            { action: "narrate", clip: "welcome" },
            { action: "wait", condition: "selector" },
          ],
        },
      ],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("selector");
  });

  it("rejects wait condition=timeout without timeout field", () => {
    const bad = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [
            { action: "narrate", clip: "welcome" },
            { action: "wait", condition: "timeout" },
          ],
        },
      ],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("timeout");
  });

  it("accepts wait condition=networkidle without extra fields", () => {
    const script = {
      ...validScript,
      scenes: [
        {
          id: "intro",
          steps: [
            { action: "narrate", clip: "welcome" },
            { action: "wait", condition: "networkidle" },
          ],
        },
      ],
    };
    const result = demoScriptSchema.parse(script);
    expect(result.scenes[0]?.steps).toHaveLength(2);
  });

  it("accepts per-clip voice and rate overrides", () => {
    const script = {
      ...validScript,
      narration: {
        ...validScript.narration,
        clips: [{ id: "custom", text: "Hello", voice: "Daniel", rate: 150 }],
      },
      scenes: [
        {
          id: "intro",
          steps: [{ action: "narrate", clip: "custom" }],
        },
      ],
    };
    const result = demoScriptSchema.parse(script);
    expect(result.narration.clips[0]?.voice).toBe("Daniel");
    expect(result.narration.clips[0]?.rate).toBe(150);
  });

  it("accepts optional auth.role", () => {
    const script = { ...validScript, auth: { role: "admin" } };
    const result = demoScriptSchema.parse(script);
    expect(result.auth?.role).toBe("admin");
  });

  it("accepts optional base_url", () => {
    const script = { ...validScript, base_url: "https://example.com" };
    const result = demoScriptSchema.parse(script);
    expect(result.base_url).toBe("https://example.com");
  });

  it("still parses a legacy browser scene with no type field", () => {
    const result = demoScriptSchema.parse(validScript);
    const scene = result.scenes[0];
    expect(scene?.type).toBeUndefined();
    if (scene && scene.type !== "card") {
      expect(scene.steps).toHaveLength(4);
    }
  });

  it("parses a card scene and applies defaults", () => {
    const script = {
      ...validScript,
      scenes: [
        { type: "card", id: "title_card", headline: "Acme Dashboard" },
        ...validScript.scenes,
      ],
    };
    const result = demoScriptSchema.parse(script);
    const card = result.scenes[0];
    expect(card?.type).toBe("card");
    if (card?.type === "card") {
      expect(card.kind).toBe("title");
      expect(card.duration_ms).toBe(4000);
      expect(card.fade).toBe(true);
    }
  });

  it("parses a credits card with lines and a voiceover clip", () => {
    const script = {
      ...validScript,
      scenes: [
        ...validScript.scenes,
        {
          type: "card",
          id: "credits",
          kind: "credits",
          headline: "Credits",
          lines: ["Built with demogen", "Narration: ElevenLabs"],
          clip: "welcome",
          duration_ms: 6000,
        },
      ],
    };
    const result = demoScriptSchema.parse(script);
    const card = result.scenes[1];
    if (card?.type === "card") {
      expect(card.lines).toHaveLength(2);
      expect(card.clip).toBe("welcome");
    }
  });

  it("rejects a card scene without a headline", () => {
    const bad = {
      ...validScript,
      scenes: [{ type: "card", id: "title_card" }, ...validScript.scenes],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow();
  });

  it("rejects a card clip referencing an unknown narration clip", () => {
    const bad = {
      ...validScript,
      scenes: [
        { type: "card", id: "title_card", headline: "Hi", clip: "nope" },
        ...validScript.scenes,
      ],
    };
    expect(() => demoScriptSchema.parse(bad)).toThrow("nope");
  });

  it("parses a background music block with defaults", () => {
    const script = { ...validScript, music: { path: "./bg.mp3" } };
    const result = demoScriptSchema.parse(script);
    expect(result.music?.path).toBe("./bg.mp3");
    expect(result.music?.volume).toBe(0.15);
  });

  it("accepts music volume/fade overrides", () => {
    const script = {
      ...validScript,
      music: { path: "./bg.mp3", volume: 0.3, fade_in_ms: 500, fade_out_ms: 1500 },
    };
    const result = demoScriptSchema.parse(script);
    expect(result.music?.volume).toBe(0.3);
    expect(result.music?.fade_out_ms).toBe(1500);
  });

  it("rejects music volume above 1", () => {
    const bad = { ...validScript, music: { path: "./bg.mp3", volume: 2 } };
    expect(() => demoScriptSchema.parse(bad)).toThrow();
  });

  it("rejects music volume of 0", () => {
    const bad = { ...validScript, music: { path: "./bg.mp3", volume: 0 } };
    expect(() => demoScriptSchema.parse(bad)).toThrow();
  });
});
