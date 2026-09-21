import { describe, it, expect, vi, afterEach } from "vitest";
import { accountFromToken, refreshCredential, withAccount, XAI_DEVICE } from "../xai-oauth";

// The device-code protocol xAI signs in with is shared, and tested in
// device-code.test.ts. What's left here is xAI's own half.
// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe("withAccount", () => {
  it("gives a token with no expires_in an hour rather than no expiry at all", () => {
    // xAI omits it on some responses. toCredential would refuse the body
    // outright, which would turn a perfectly good sign-in into a failure.
    const before = Date.now();
    const credential = withAccount({ access_token: "at", refresh_token: "rt" });
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("prefers the expiry the server actually sent", () => {
    const before = Date.now();
    const credential = withAccount({ access_token: "at", refresh_token: "rt", expires_in: 7200 });
    expect(credential.expiresAt).toBeGreaterThan(before + 114 * 60_000);
  });

  it("names the account off the token", () => {
    const credential = withAccount({
      access_token: jwt({ email: "Gus@Example.COM" }),
      refresh_token: "rt",
      expires_in: 60,
    });
    expect(credential.account).toBe("gus@example.com");
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
  it("falls back to the subject when the token carries no email", () => {
    expect(accountFromToken(jwt({ sub: "user-42" }))).toBe("user-42");
  });

  it("returns undefined for anything that isn't a readable JWT", () => {
    expect(accountFromToken("opaque-token")).toBeUndefined();
  });
});

describe("XAI_DEVICE", () => {
  it("asks for the scopes inference needs, and names us as the referrer", () => {
    // `api:access` is the half that makes the token usable for chat; without
    // it the sign-in succeeds and every run 401s.
    expect(XAI_DEVICE.scope).toContain("api:access");
    expect(XAI_DEVICE.scope).toContain("offline_access");
    expect(XAI_DEVICE.extra).toEqual({ referrer: "tabrunner" });
  });
});
