import { describe, it, expect } from "vitest";
import {
  getActiveProvider,
  getProvider,
  getProviders,
  saveProvider,
  setActiveProvider,
} from "../storage";
import type { ProviderConfig } from "../types";

// Storage stand-in comes from src/test-setup.ts (vitest setupFiles).

const shimRow: ProviderConfig = {
  id: "gemini",
  name: "Gemini",
  shape: "openai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "sk-test",
  createdAt: 0,
};

describe("provider row migration", () => {
  it("keeps disabled credentials saved without choosing them as the active chat provider", async () => {
    const zen: ProviderConfig = {
      ...shimRow,
      id: "opencode",
      name: "OpenCode Zen",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "oc_saved",
    };
    await saveProvider(zen);
    await setActiveProvider(zen.id);
    expect(await getActiveProvider()).toBeUndefined();
    await saveProvider({ ...shimRow, id: "custom-1" });
    expect((await getActiveProvider())?.id).toBe("custom-1");
    expect(await getProvider(zen.id)).toEqual(zen);
    expect(await getProviders()).toHaveLength(2);
  });

  it("re-points a stored Gemini shim row at the native endpoint on read", async () => {
    await saveProvider(shimRow);
    const found = (await getProviders()).find((p) => p.id === "gemini");
    expect(found?.shape).toBe("gemini");
    expect(found?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("leaves custom rows alone, even on a lookalike base", async () => {
    await saveProvider({ ...shimRow, id: "custom-1", name: "My gateway" });
    const found = (await getProviders()).find((p) => p.id === "custom-1");
    expect(found?.shape).toBe("openai");
    expect(found?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  });
});
