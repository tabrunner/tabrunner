import { describe, it, expect } from "vitest";
import {
  CONTEXT_RESERVE,
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFor,
  knownContextWindow,
  needsCompaction,
} from "../context-window";
import { writeModelsCache, modelsTarget } from "../models";
import type { ProviderConfig } from "../types";

function config(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "openai",
    name: "OpenAI",
    shape: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-5",
    ...over,
  } as ProviderConfig;
}

describe("contextWindowFor", () => {
  it("falls back to the 200k default when nobody has said otherwise", () => {
    expect(contextWindowFor(config(), {})).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("takes the endpoint's own context_length when the listing ships one", () => {
    const provider = config({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    writeModelsCache(modelsTarget(provider), [{ id: "gpt-5", contextLength: 400_000 }]);
    expect(contextWindowFor(provider, {})).toBe(400_000);
  });

  it("prefers a learned ceiling over everything — it is the only measured number", () => {
    const provider = config({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    writeModelsCache(modelsTarget(provider), [{ id: "gpt-5", contextLength: 400_000 }]);
    expect(contextWindowFor(provider, { "openrouter:gpt-5": 128_000 })).toBe(128_000);
  });

  it("keys the learned map by provider AND model, so one endpoint never teaches another", () => {
    expect(contextWindowFor(config(), { "anthropic:gpt-5": 8_000 })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(config(), { "openai:gpt-4": 8_000 })).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("knownContextWindow", () => {
  it("says nothing rather than hand back the default guess", () => {
    // The gauge draws a bar and a ratio off this. A guessed denominator would
    // render a made-up percentage the user then acts on — so the honest answer
    // to "how big is this window" is often "we don't know".
    expect(knownContextWindow(config(), {})).toBeUndefined();
  });

  it("answers with the numbers somebody actually measured or published", () => {
    const provider = config({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    writeModelsCache(modelsTarget(provider), [{ id: "gpt-5", contextLength: 400_000 }]);
    expect(knownContextWindow(provider, {})).toBe(400_000);
    expect(knownContextWindow(provider, { "openrouter:gpt-5": 128_000 })).toBe(128_000);
  });
});

describe("needsCompaction", () => {
  it("trips once the reserve is all that's left, not at a fixed percentage", () => {
    expect(needsCompaction(100_000, 200_000)).toBe(false);
    expect(needsCompaction(200_000 - CONTEXT_RESERVE, 200_000)).toBe(true);
    // The same absolute headroom on a small window — a percentage would leave
    // far too little room to finish a turn here.
    expect(needsCompaction(20_000, 32_000)).toBe(true);
  });

  it("stays quiet before any turn has reported usage", () => {
    expect(needsCompaction(0, 200_000)).toBe(false);
  });
});
