import { describe, expect, it } from "vitest";
import { isZenFreeModel } from "@providerkit/core";
import { PRESETS, presetSection, providerDisplayName, providerName } from "../presets";

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

  it("keeps every picker section one run", () => {
    // The picker chunks PRESETS into sections by scanning runs, never sorting —
    // a row parked out of place would open a second heading of the same name.
    const sections = PRESETS.map(presetSection);
    const runs = sections.filter((section, i) => section !== sections[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("opens on Antigravity without giving it Zen's transport flags", () => {
    expect(PRESETS[0]?.id).toBe("antigravity");
    expect(presetSection(PRESETS[0]!)).toBe("free");
    expect(PRESETS[0]?.auth).toBe("oauth");
    expect(PRESETS[0]?.free).toBeUndefined();
    expect(PRESETS[0]?.sessionHeader).toBeUndefined();
  });

  it("keeps Zen's integration behind a disabled flag at the bottom", () => {
    const zen = PRESETS.find((p) => p.id === "opencode");
    expect(zen?.signIn).toBe("account");
    expect(zen?.auth).toBeUndefined();
    expect(zen?.free).toBe(true);
    expect(zen?.disabled).toBe(true);
    expect(zen && presetSection(zen)).toBe("unavailable");
    expect(PRESETS.at(-1)).toBe(zen);
  });

  it("leads Zen's cold-start list with models its free tier serves", () => {
    const zen = PRESETS.find((p) => p.id === "opencode");
    expect(zen?.models.slice(0, 5).every(isZenFreeModel)).toBe(true);
  });

  it("sends each Zen family to one wire, and the free shelf to none of them", () => {
    const routes = PRESETS.find((p) => p.id === "opencode")?.modelRoutes;
    const all = [
      ...(routes?.responses ?? []),
      ...(routes?.anthropic ?? []),
      ...(routes?.gemini ?? []),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.some(isZenFreeModel)).toBe(false);
    expect(routes?.gemini?.every((id) => id.startsWith("gemini-"))).toBe(true);
  });

  it("gives Antigravity a path and a fixed model list, since its backend lists none", () => {
    const antigravity = PRESETS.find((p) => p.id === "antigravity");
    expect(antigravity?.shape).toBe("gemini");
    expect(antigravity?.path).toBe("/v1internal:streamGenerateContent?alt=sse");
    expect(antigravity?.staticModels).toBe(true);
    expect(antigravity?.auth).toBe("oauth");
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

  it("names a session header only where the endpoint reads one", () => {
    // OpenCode's free tier answers FreeTierError without its routing header;
    // the ChatGPT backend keys its prompt cache on `session-id`.
    const flagged = PRESETS.filter((p) => p.sessionHeader).map((p) => [p.id, p.sessionHeader]);
    expect(flagged).toEqual([
      ["chatgpt", "session-id"],
      ["opencode-go", "x-opencode-session"],
      ["opencode", "x-opencode-session"],
    ]);
  });

  it("never advertises a retired Zen id as fallback", () => {
    // A dead free id answers 500 at run time; the live listing is authoritative
    // but a cold open still offers these. `ox-alpha` was GLM-5.3-flash's
    // anonymous test name and is retired. So are the contributor-free Spark and
    // `mimo-v2.5-free`: Zen's live /models no longer lists either (2026-10-21).
    const ids = PRESETS.filter((p) => p.id === "opencode" || p.id === "opencode-go").flatMap(
      (p) => p.models,
    );
    expect(ids).not.toContain("ox-alpha-free");
    expect(ids).not.toContain("muse-spark-1.3-contributor-free");
    expect(ids).not.toContain("mimo-v2.5-free");
    expect(ids.some((id) => id.includes("comunity"))).toBe(false);
  });

  it("routes Go's contributor Spark to Responses like the rest of its family", () => {
    // This id 500s on chat completions — the whole point of the routing table.
    const go = PRESETS.find((p) => p.id === "opencode-go");
    expect(go?.models).toContain("muse-spark-1.3-contributor");
    expect(go?.modelRoutes?.responses).toContain("muse-spark-1.3-contributor");
  });

  it("leads Go with MiMo v2.6 Flash and routes its GPT and Grok ids to Responses", () => {
    // Go's docs (Endpoints table) and its live /models, 2026-09-27: grok-4.5
    // is gone, and grok-4.7/4.6 and gpt-6-luna are served on /responses.
    const go = PRESETS.find((p) => p.id === "opencode-go");
    expect(go?.models[0]).toBe("mimo-v2.6-flash");
    expect(go?.modelRoutes?.responses).toEqual(
      expect.arrayContaining(["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna"]),
    );
    expect(go?.modelRoutes?.responses).not.toContain("grok-4.5");
  });
});
