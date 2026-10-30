import { describe, it, expect } from "vitest";
import {
  assertChatProviderSupported,
  byCredentialStatus,
  canSignIn,
  credentialStatus,
  isChatProviderSupported,
  isOAuthProvider,
} from "../status";
import { PRESETS } from "../presets";
import { ProviderError } from "../types";
import type { ProviderConfig } from "../types";

function config(over: Partial<ProviderConfig> & Pick<ProviderConfig, "id">): ProviderConfig {
  return {
    name: over.id,
    shape: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "",
    createdAt: 0,
    ...over,
  };
}

const auth = { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 60_000 };

describe("credentialStatus", () => {
  it("counts a pasted key as connected", () => {
    expect(credentialStatus(config({ id: "openai", apiKey: "sk-1" }))).toBe("connected");
    expect(credentialStatus(config({ id: "openai" }))).toBe("missing");
  });

  it("treats a local endpoint as connected without any credential", () => {
    // Ollama needs no key — showing it as broken would be a lie.
    expect(credentialStatus(config({ id: "ollama", baseUrl: "http://localhost:11434/v1" }))).toBe(
      "connected",
    );
  });

  it("judges an OAuth provider by its sign-in, not by the empty apiKey", () => {
    expect(credentialStatus(config({ id: "kimi-plan" }))).toBe("missing");
    expect(credentialStatus(config({ id: "kimi-plan", auth }))).toBe("connected");
  });

  it("counts a sign-in on a keyed row, which holds no key, as connected", () => {
    expect(credentialStatus(config({ id: "openrouter", auth }))).toBe("connected");
    expect(credentialStatus(config({ id: "openrouter", apiKey: "sk-or-1" }))).toBe("connected");
    expect(credentialStatus(config({ id: "openrouter" }))).toBe("missing");
    expect(credentialStatus(config({ id: "opencode-go" }))).toBe("missing");
  });

  it("never marks disabled Zen chat access connected, without changing its credentials", () => {
    for (const apiKey of ["", "public", "oc_sk_1"]) {
      const saved = config({ id: "opencode", apiKey, auth });
      expect(credentialStatus(saved)).toBe("missing");
      expect(credentialStatus(config({ id: "opencode", apiKey }))).toBe("missing");
      expect(saved).toMatchObject({ apiKey, auth });
    }
  });

  it("stays connected on a stale token — the next run refreshes it silently", () => {
    const stale = { ...auth, expiresAt: Date.now() - 60_000 };
    expect(credentialStatus(config({ id: "kimi-plan", auth: stale }))).toBe("connected");
  });
});

describe("isChatProviderSupported", () => {
  it("disables only flagged presets, not Go or custom endpoints", () => {
    expect(isChatProviderSupported({ id: "opencode" })).toBe(false);
    expect(isChatProviderSupported({ id: "opencode-go" })).toBe(true);
    expect(isChatProviderSupported({ id: "custom-opencode" })).toBe(true);
    const router = PRESETS.find((preset) => preset.id === "openrouter");
    if (!router) throw new Error("Missing OpenRouter preset");
    router.disabled = true;
    try {
      expect(isChatProviderSupported(router)).toBe(false);
      expect(canSignIn(router.id)).toBe(false);
    } finally {
      delete router.disabled;
    }
  });

  it("preserves Zen's free and signed-in behavior when the flag is removed", () => {
    const zen = PRESETS.find((preset) => preset.id === "opencode");
    if (!zen) throw new Error("Missing Zen preset");
    delete zen.disabled;
    try {
      expect(isChatProviderSupported(zen)).toBe(true);
      expect(canSignIn(zen.id)).toBe(true);
      expect(credentialStatus(config({ id: zen.id }))).toBe("connected");
      expect(credentialStatus(config({ id: zen.id, apiKey: "public" }))).toBe("connected");
      expect(credentialStatus(config({ id: zen.id, auth }))).toBe("connected");
      expect(credentialStatus(config({ id: zen.id, apiKey: "oc_sk_1" }))).toBe("connected");
    } finally {
      zen.disabled = true;
    }
  });

  it("keeps onboarding eligible when saved rows support no chat provider", () => {
    const saved = [config({ id: "opencode", auth })];
    expect(saved.some(isChatProviderSupported)).toBe(false);
    expect([...saved, config({ id: "openrouter" })].some(isChatProviderSupported)).toBe(true);
    expect([].some(isChatProviderSupported)).toBe(false);
  });
});

describe("assertChatProviderSupported", () => {
  it("fails with an actionable non-retryable error without changing credentials", () => {
    const saved = config({ id: "opencode", name: "OpenCode Zen", apiKey: "saved", auth });
    let failure: unknown;
    try {
      assertChatProviderSupported(saved);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({
      status: 410,
      kind: "model",
      message: "OpenCode Zen is unavailable for chats in TabRunner. Choose another provider.",
    });
    expect(saved).toMatchObject({ apiKey: "saved", auth });
    expect(() => assertChatProviderSupported(config({ id: "opencode-go" }))).not.toThrow();
    expect(() => assertChatProviderSupported(config({ id: "custom-opencode" }))).not.toThrow();
  });
});

describe("isOAuthProvider", () => {
  it("distinguishes the two Kimi rows — same endpoint, different credential", () => {
    expect(isOAuthProvider("kimi-plan")).toBe(true);
    expect(isOAuthProvider("kimi")).toBe(false);
    expect(isOAuthProvider("custom-123")).toBe(false);
  });
});

describe("canSignIn", () => {
  it("is true for subscriptions and for keyed rows that also take a sign-in", () => {
    expect(canSignIn("claude")).toBe(true);
    expect(canSignIn("antigravity")).toBe(true);
    expect(canSignIn("openrouter")).toBe(true);
  });

  it("is false for rows that only take a key, and for custom endpoints", () => {
    expect(canSignIn("deepseek")).toBe(false);
    expect(canSignIn("opencode")).toBe(false);
    expect(canSignIn("opencode-go")).toBe(false);
    expect(canSignIn("custom-123")).toBe(false);
  });
});

describe("byCredentialStatus", () => {
  it("puts usable providers first and keeps original order within a group", () => {
    const list = [
      config({ id: "opencode", auth }), // disabled
      config({ id: "openai" }), // missing
      config({ id: "anthropic", apiKey: "sk-a" }), // connected
      config({ id: "kimi-plan" }), // missing
      config({ id: "kimi", apiKey: "sk-k" }), // connected
    ];
    expect([...list].sort(byCredentialStatus).map((p) => p.id)).toEqual([
      "anthropic",
      "kimi",
      "openai",
      "kimi-plan",
      "opencode",
    ]);
  });
});
