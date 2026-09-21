import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  chatgptAccountIdFromToken,
  exchangeCode,
  refreshCredential,
} from "../chatgpt-oauth";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A JWT whose payload is `claims` — signature is never checked, only decoded. */
function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe("buildAuthorizeUrl", () => {
  it("carries the OAuth + PKCE + Codex params on the auth.openai.com authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl("challenge-x", "state-y"));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
      code_challenge: "challenge-x",
      code_challenge_method: "S256",
      state: "state-y",
      codex_cli_simplified_flow: "true",
      originator: "opencodex",
      id_token_add_organizations: "true",
    });
  });
});

describe("exchangeCode", () => {
  it("trades a code for a credential with the refresh skew baked in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );
    const before = Date.now();
    const credential = await exchangeCode("code-1", "verifier-x");
    expect(credential).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    // 1h lifetime, 5min skew → ~55min out, never the raw hour.
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("extracts the account id the Codex backend requires from the id_token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        id_token: jwt({ email: "Gus@Example.com", chatgpt_account_id: "acct-7" }),
      }),
    );
    const credential = await exchangeCode("code-1", "verifier-x");
    expect(credential.chatgptAccountId).toBe("acct-7");
    expect(credential.account).toBe("gus@example.com");
  });

  it("throws on an incomplete token response instead of a half-built credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ access_token: "at" }));
    await expect(exchangeCode("c", "v")).rejects.toThrow();
  });
});

describe("refreshCredential", () => {
  it("keeps the old refresh token AND the account id when the response omits both", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at-2", expires_in: 3600 }),
    );
    const next = await refreshCredential({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
      chatgptAccountId: "acct-7",
    });
    expect(next).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
    // The header value must never go stale across a rotation.
    expect(next.chatgptAccountId).toBe("acct-7");
  });

  it("re-extracts the account id from the rotated access token when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        access_token: jwt({ chatgpt_account_id: "acct-9" }),
        refresh_token: "rt-2",
        expires_in: 3600,
      }),
    );
    const next = await refreshCredential({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
      chatgptAccountId: "acct-9",
    });
    expect(next.chatgptAccountId).toBe("acct-9");
  });
});

describe("chatgptAccountIdFromToken", () => {
  it("reads the top-level chatgpt_account_id claim", () => {
    expect(chatgptAccountIdFromToken(jwt({ chatgpt_account_id: "acct-1" }))).toBe("acct-1");
  });

  it("reads the claim nested under https://api.openai.com/auth", () => {
    expect(
      chatgptAccountIdFromToken(
        jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" } }),
      ),
    ).toBe("acct-2");
  });

  it("falls back to the first organization id", () => {
    expect(chatgptAccountIdFromToken(jwt({ organizations: [{ id: "org-3" }] }))).toBe("org-3");
  });

  it("returns undefined for anything without the account", () => {
    expect(chatgptAccountIdFromToken(jwt({ email: "a@b.com" }))).toBeUndefined();
    expect(chatgptAccountIdFromToken("not-a-jwt")).toBeUndefined();
    expect(chatgptAccountIdFromToken(undefined)).toBeUndefined();
  });
});
