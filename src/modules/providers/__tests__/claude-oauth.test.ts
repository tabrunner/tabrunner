import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAuthorizeUrl, exchangeCode, refreshCredential } from "../claude-oauth";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("buildAuthorizeUrl", () => {
  it("carries the OAuth + PKCE params on the claude.ai authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl("challenge-x", "state-y"));
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: "http://localhost:54545/callback",
      // No org:create_api_key — a token that can mint durable API keys on the
      // user's org is a liability we would never spend.
      scope: "user:profile user:inference",
      code_challenge: "challenge-x",
      code_challenge_method: "S256",
      state: "state-y",
    });
  });
});

describe("exchangeCode", () => {
  it("posts to the API host, not the console frontend", async () => {
    // platform.claude.com is a web frontend behind bot protection: an extension
    // fetch lands there with a chrome-extension:// Origin and comes back 429
    // with nothing wrong on the account. Every current client uses this host.
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    await exchangeCode("code-1", "state-y", "verifier-x");
    expect(mock.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/oauth/token");
  });

  it("trades a code for a credential with the refresh skew baked in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );
    const before = Date.now();
    const credential = await exchangeCode("code-1", "state-y", "verifier-x");
    expect(credential).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    // 1h lifetime, 5min skew → ~55min out, never the raw hour.
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("reads the account name from the token response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        account: { email_address: "Gus@Example.com" },
      }),
    );
    const credential = await exchangeCode("code-1", "s", "v");
    expect(credential.account).toBe("gus@example.com");
  });

  it("throws on an incomplete token response instead of a half-built credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ access_token: "at" }));
    await expect(exchangeCode("c", "s", "v")).rejects.toThrow();
  });
});

describe("refreshCredential", () => {
  it("keeps the old refresh token when the response omits a new one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at-2", expires_in: 3600 }),
    );
    const next = await refreshCredential({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
    });
    expect(next).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });
});
