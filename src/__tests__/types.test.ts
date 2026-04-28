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
});
