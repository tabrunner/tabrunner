import { describe, it, expect, vi, afterEach } from "vitest";
import { accountFromToken, refreshCredential, withAccount } from "../kimi-oauth";

// The device-code protocol Kimi signs in with is shared, and tested in
// device-code.test.ts. What's left here is Kimi's own half: renewal, and which
// claim names the account.
// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A JWT whose payload is `claims` — signature is never checked, only decoded. */
function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe("withAccount", () => {
  it("bakes the refresh skew into expiresAt so readers need no margin", () => {
    const before = Date.now();
    const credential = withAccount({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    // 1h lifetime, 5min skew → ~55min out, never the raw hour.
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("names the account off the token", () => {
    const credential = withAccount({
      access_token: jwt({ email: "gus@example.com" }),
      refresh_token: "rt",
      expires_in: 60,
    });
    expect(credential.account).toBe("gus@example.com");
  });
});

describe("refreshCredential", () => {
  it("persists the rotated pair", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    );
    const next = await refreshCredential({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
    });
    expect(next).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
  });

  it("keeps the old refresh token when the response omits a new one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at-2", expires_in: 3600 }),
    );
    const next = await refreshCredential({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
    });
    expect(next.refreshToken).toBe("rt-1");
  });

  it("throws on a rejected refresh token so the caller can clear it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ error: "invalid_grant", error_description: "expired" }, 400),
    );
    await expect(
      refreshCredential({ accessToken: "a", refreshToken: "dead", expiresAt: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("accountFromToken", () => {
  it("prefers the email, lowercased", () => {
    expect(accountFromToken(jwt({ email: "Gus@Example.COM", user_id: "u1" }))).toBe(
      "gus@example.com",
    );
  });

  it("falls back to an id when there is no email", () => {
    expect(accountFromToken(jwt({ user_id: "u-42" }))).toBe("u-42");
    expect(accountFromToken(jwt({ sub: "s-7" }))).toBe("s-7");
  });

  it("returns undefined for anything that isn't a readable JWT", () => {
    // The row then just says "Signed in" — never a crash, never a raw token.
    expect(accountFromToken("not-a-jwt")).toBeUndefined();
    expect(accountFromToken("a.!!!not-base64!!!.c")).toBeUndefined();
    expect(accountFromToken("")).toBeUndefined();
  });
});
