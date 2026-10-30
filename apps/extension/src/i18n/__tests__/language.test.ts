import { describe, it, expect, vi, beforeAll } from "vitest";

// The locale item reads wxt storage at module scope — no chrome in tests.
vi.mock("wxt/utils/storage", () => ({
  storage: {
    defineItem: (_key: string, opts?: { fallback?: unknown }) => {
      let value: unknown = opts?.fallback ?? null;
      return {
        getValue: async () => value,
        setValue: async (v: unknown) => void (value = v),
        removeValue: async () => void (value = null),
        watch: () => () => {},
      };
    },
  },
}));

import { i18n, initI18n, currentLanguageName } from "@/i18n";

// Module scope — evaluated before any hook, so this is the genuine pre-init answer.
const beforeInit = currentLanguageName();

describe("currentLanguageName", () => {
  beforeAll(async () => {
    await initI18n();
  });

  it("falls back to English before init", () => {
    expect(beforeInit).toBe("English");
  });

  it("names the resolved language once i18n is up", () => {
    // No stored override; jsdom's navigator.language is en-US.
    expect(currentLanguageName()).toBe("English");
  });

  it("follows language changes", async () => {
    await i18n.changeLanguage("pt-BR");
    expect(currentLanguageName()).toBe("Português (Brasil)");
    await i18n.changeLanguage("en");
  });
});
