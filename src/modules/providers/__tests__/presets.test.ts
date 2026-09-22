import { describe, expect, it } from "vitest";
import { PRESETS, providerDisplayName, providerName } from "../presets";

describe("provider names", () => {
  it("qualifies only the products sold two ways", () => {
    // A plan and a key spend different quotas — the label has to say which.
    expect(providerDisplayName({ id: "claude", name: "" })).toBe("Claude (Subscription)");
    expect(providerDisplayName({ id: "anthropic", name: "" })).toBe("Anthropic (API key)");
    // One row, one way to pay, nothing to disambiguate.
    expect(providerDisplayName({ id: "deepseek", name: "" })).toBe("DeepSeek");
  });

  it("keeps the bare product name for surfaces that say the method themselves", () => {
    expect(providerName({ id: "claude", name: "" })).toBe("Claude");
    expect(providerName({ id: "anthropic", name: "" })).toBe("Anthropic");
  });

  it("falls back to the stored name for custom endpoints", () => {
    expect(providerDisplayName({ id: "custom-1", name: "My gateway" })).toBe("My gateway");
  });

  it("pairs presets in twos", () => {
    // A lone `paired` row would wear a qualifier answering a question nobody asked.
    const paired = PRESETS.filter((p) => p.paired);
    expect(paired.filter((p) => p.auth === "oauth")).toHaveLength(paired.length / 2);
  });

  it("keeps the subscription rows contiguous", () => {
    // The picker chunks PRESETS into sections by scanning runs, never sorting —
    // an OAuth row parked lower down would open a second Subscription heading.
    const oauth = PRESETS.map((p) => p.auth === "oauth");
    expect(oauth.lastIndexOf(true)).toBe(oauth.filter(Boolean).length - 1);
  });

  it("leads Z.ai with the current flagship shelf", () => {
    // GLM-5.3 + 5.3-flash are fully available on the coding plan; the preset is
    // the cold open and the auto fallback, so a stale id here is a model the
    // endpoint no longer serves.
    const zai = PRESETS.find((p) => p.id === "zai");
    expect(zai?.models.slice(0, 2)).toEqual(["glm-5.3", "glm-5.3-flash"]);
  });

  it("leads Gemini with the 3.x shelf — 2.x is being retired", () => {
    // 2.5-flash-lite already 404s naming 3.5-flash-lite as its replacement.
    const gemini = PRESETS.find((p) => p.id === "gemini");
    expect(gemini?.models[0]).toBe("gemini-3.5-flash");
  });

  it("asks for the session header only on the OpenCode gateway rows", () => {
    // The free tier answers FreeTierError without the per-conversation routing
    // header; no other endpoint wants it.
    const flagged = PRESETS.filter((p) => p.sessionHeader).map((p) => p.id);
    expect(flagged).toEqual(["opencode", "opencode-go"]);
  });

  it("never advertises a retired Zen id as fallback", () => {
    // A dead free id answers 500 at run time; the live listing is authoritative
    // but a cold open still offers these. `ox-alpha` was GLM-5.3-flash's
    // anonymous test name, and no free Muse Spark ever existed on Zen.
    const ids = PRESETS.filter((p) => p.id === "opencode" || p.id === "opencode-go").flatMap(
      (p) => p.models,
    );
    expect(ids).not.toContain("ox-alpha-free");
    expect(ids.some((id) => id.includes("comunity"))).toBe(false);
    expect(ids).not.toContain("muse-spark-1.3-contributor-free");
  });
});
