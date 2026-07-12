import { describe, expect, it } from "vitest";
import { buildCardHtml, cardDurationMs } from "../cards.js";
import { groupScenes } from "../runner.js";
import type { DemoCardScene, DemoScene } from "../types.js";

const titleCard: DemoCardScene = {
  type: "card",
  id: "title_card",
  kind: "title",
  headline: "Acme Dashboard",
  subtitle: "A 90-second tour",
  duration_ms: 4000,
  fade: true,
};

describe("buildCardHtml", () => {
  it("includes the headline, subtitle, and escaped credit lines", () => {
    const html = buildCardHtml(
      { ...titleCard, lines: ["Built with <demogen>", "Music: A & B"] },
      { width: 1280, height: 720 },
    );
    expect(html).toContain("Acme Dashboard");
    expect(html).toContain("A 90-second tour");
    expect(html).toContain("Built with &lt;demogen&gt;");
    expect(html).toContain("Music: A &amp; B");
  });

  it("uses a custom background when provided", () => {
    const html = buildCardHtml({ ...titleCard, background: "#ff0000" }, { width: 1280, height: 720 });
    expect(html).toContain("#ff0000");
  });
});

describe("cardDurationMs", () => {
  it("returns the configured duration when there is no narration", () => {
    expect(cardDurationMs(titleCard)).toBe(4000);
  });

  it("extends to fit a longer voiceover", () => {
    // 5000ms narration + lead + tail exceeds the 4000ms floor.
    expect(cardDurationMs(titleCard, 5000)).toBeGreaterThan(5000);
  });

  it("keeps the floor when narration is short", () => {
    expect(cardDurationMs(titleCard, 500)).toBe(4000);
  });
});

describe("groupScenes", () => {
  const browser = (id: string): DemoScene =>
    ({ id, steps: [{ action: "wait", condition: "networkidle" }] }) as DemoScene;
  const card = (id: string): DemoScene =>
    ({ type: "card", id, kind: "title", headline: id, duration_ms: 4000, fade: true }) as DemoScene;

  it("groups a contiguous browser run into one segment", () => {
    const segments = groupScenes([browser("a"), browser("b")]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("browser");
    if (segments[0]?.kind === "browser") expect(segments[0].scenes).toHaveLength(2);
  });

  it("splits browser runs around interleaved cards, preserving order", () => {
    const segments = groupScenes([
      card("title"),
      browser("a"),
      browser("b"),
      card("mid"),
      browser("c"),
      card("credits"),
    ]);
    expect(segments.map((s) => s.kind)).toEqual([
      "card",
      "browser",
      "card",
      "browser",
      "card",
    ]);
    const firstBrowser = segments[1];
    if (firstBrowser?.kind === "browser") expect(firstBrowser.scenes).toHaveLength(2);
  });
});
