import { describe, it, expect } from "vitest";
import { getProviders, saveProvider } from "../storage";
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
