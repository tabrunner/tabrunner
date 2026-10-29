import { describe, expect, it } from "vitest";
import { engineOf, engineProvider, sameEngine } from "../engine";
import type { ProviderConfig } from "../types";

/**
 * The one resolution rule: a conversation's pin, else the stored pick, else the
 * first configured. What is pinned is the PICK — so an absent model still means
 * auto, and a pin can never inherit a model the user did not choose.
 */
const provider = (id: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id,
  name: id,
  shape: "openai",
  baseUrl: `https://${id}.test`,
  apiKey: "sk-test",
  createdAt: 0,
  ...extra,
});

const ANTHROPIC = provider("anthropic", { model: "claude-x", reasoningEffort: "high" });
const OPENAI = provider("openai", { model: "gpt-x" });
const ALL = [ANTHROPIC, OPENAI];

describe("engineProvider", () => {
  it("falls back to the stored pick, then to the first configured", () => {
    expect(engineProvider(ALL, "openai")?.id).toBe("openai");
    expect(engineProvider(ALL, null)?.id).toBe("anthropic");
    expect(engineProvider([], "openai")).toBeUndefined();
  });

  it("lets the pin outrank the stored pick", () => {
    const resolved = engineProvider(ALL, "openai", { providerId: "anthropic" });
    expect(resolved?.id).toBe("anthropic");
  });

  it("reads an absent model on the pin as auto, not as the provider's default", () => {
    // The whole point of storing the pick: pinning "auto" must survive, or a
    // conversation could never be un-pinned from a model.
    const resolved = engineProvider(ALL, "openai", { providerId: "anthropic" });
    expect(resolved?.model).toBeUndefined();
    expect(resolved?.reasoningEffort).toBeUndefined();
  });

  it("overlays the pin's own model and effort", () => {
    const resolved = engineProvider(ALL, "openai", {
      providerId: "anthropic",
      model: "claude-y",
      effort: "low",
    });
    expect(resolved?.model).toBe("claude-y");
    expect(resolved?.reasoningEffort).toBe("low");
    // Never mutates what is stored — the overlay is this run's view only.
    expect(ANTHROPIC.model).toBe("claude-x");
  });

  it("degrades to the stored pick when the pinned provider is gone", () => {
    const resolved = engineProvider(ALL, "openai", { providerId: "deleted", model: "ghost-1" });
    expect(resolved?.id).toBe("openai");
    // And nothing of the dead pin leaks through.
    expect(resolved?.model).toBe("gpt-x");
  });
});

describe("engineOf / sameEngine", () => {
  it("snapshots only what was chosen", () => {
    expect(engineOf(ANTHROPIC)).toEqual({
      providerId: "anthropic",
      model: "claude-x",
      effort: "high",
    });
    expect(engineOf(provider("bare"))).toEqual({ providerId: "bare" });
  });

  it("guards the pin write, including the never-pinned case", () => {
    expect(sameEngine(undefined, { providerId: "a" })).toBe(false);
    expect(sameEngine({ providerId: "a" }, { providerId: "a" })).toBe(true);
    expect(sameEngine({ providerId: "a", model: "m" }, { providerId: "a" })).toBe(false);
    expect(
      sameEngine({ providerId: "a", effort: "low" }, { providerId: "a", effort: "high" }),
    ).toBe(false);
  });
});
