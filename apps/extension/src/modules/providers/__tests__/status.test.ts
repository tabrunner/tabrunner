import { describe, it, expect } from "vitest";
import { byCredentialStatus, canSignIn, credentialStatus, isOAuthProvider } from "../status";
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
    // OpenCode Zen and OpenRouter take a key OR a sign-in. A signed-in one has
    // `auth` and an empty apiKey, and the key check alone called it missing.
    expect(credentialStatus(config({ id: "opencode", auth }))).toBe("connected");
    expect(credentialStatus(config({ id: "opencode", apiKey: "oc_sk_1" }))).toBe("connected");
    expect(credentialStatus(config({ id: "opencode" }))).toBe("connected");
    expect(credentialStatus(config({ id: "opencode", apiKey: "public" }))).toBe("connected");
    expect(credentialStatus(config({ id: "opencode-go" }))).toBe("missing");
  });

  it("stays connected on a stale token — the next run refreshes it silently", () => {
    const stale = { ...auth, expiresAt: Date.now() - 60_000 };
    expect(credentialStatus(config({ id: "kimi-plan", auth: stale }))).toBe("connected");
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
    expect(canSignIn("opencode")).toBe(true);
    expect(canSignIn("openrouter")).toBe(true);
  });

  it("is false for rows that only take a key, and for custom endpoints", () => {
    expect(canSignIn("deepseek")).toBe(false);
    expect(canSignIn("opencode-go")).toBe(false);
    expect(canSignIn("custom-123")).toBe(false);
  });
});

describe("byCredentialStatus", () => {
  it("puts usable providers first and keeps original order within a group", () => {
    const list = [
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
    ]);
  });
});
