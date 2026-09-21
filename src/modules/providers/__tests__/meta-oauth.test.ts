import { describe, it, expect, vi, afterEach } from "vitest";
import { META_DEVICE, refreshCredential, withAccount } from "../meta-oauth";

// The device-code protocol Meta signs in with is shared, and tested in
// device-code.test.ts. What's left here is the second hop — trading the
// identity token for a Model API key.
// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A JWT whose payload is `claims` — the signature is never checked, only decoded. */
const jwt = (claims: Record<string, unknown>) =>
  `header.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

afterEach(() => vi.restoreAllMocks());

describe("withAccount", () => {
  it("keeps the identity token as the refresh token and the minted key as the bearer", async () => {
    // Only the identity token can mint another key, so losing it means signing
    // in again — it is not an OAuth refresh token, but it sits in that slot.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ api_key: "meta-key-1" }));

    const credential = await withAccount({ access_token: "identity-1" });
    expect(credential).toMatchObject({ accessToken: "meta-key-1", refreshToken: "identity-1" });
    // About a day, skewed early so the seam re-mints before it dies.
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect(credential.expiresAt).toBeLessThan(Date.now() + 24 * 60 * 60_000);
  });

  it("names the account off the identity token — the minted key is opaque", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ api_key: "k" }));

    const credential = await withAccount({ access_token: jwt({ email: "Gus@Example.COM" }) });
    expect(credential.account).toBe("gus@example.com");
  });

  it("points at Meta's own setup page when the account has no Muse yet", async () => {
    // Meta answers 200 with no key and a place to go. A bare "sign-in failed"
    // here would be a dead end: nothing is broken, the setup just isn't done.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ action_url: "https://meta.ai/muse/setup" }),
    );
    await expect(withAccount({ access_token: "identity-1" })).rejects.toThrow(
      /meta\.ai\/muse\/setup/,
    );
  });

  it("drops an action_url that isn't an https page", async () => {
    // It arrives off the network and ends up in a message the user is invited
    // to act on — the fallback copy still says what to do, just not where.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ action_url: "javascript:alert(1)" }),
    );

    const error = await withAccount({ access_token: "identity-1" }).catch((e: unknown) => e);
    expect(String(error)).not.toContain("javascript");
    expect(String(error)).toMatch(/sign in again/i);
  });

  it("surfaces a dead session with its status, so the seam can clear the credential", async () => {
    // The identity token is not renewable — a 401 here means only a fresh
    // sign-in helps, which is exactly what clearing the credential offers.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ detail: "expired" }, 401));
    await expect(withAccount({ access_token: "identity-1" })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("refuses a poll body with no identity token rather than minting from undefined", async () => {
    await expect(withAccount({})).rejects.toThrow();
  });
});

describe("refreshCredential", () => {
  it("re-mints from the identity token and keeps the name already on screen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ api_key: "meta-key-2" }));

    const next = await refreshCredential({
      accessToken: "meta-key-1",
      refreshToken: "identity-1",
      expiresAt: 0,
      account: "gus@example.com",
    });
    expect(next).toMatchObject({
      accessToken: "meta-key-2",
      refreshToken: "identity-1",
      account: "gus@example.com",
    });
  });
});

describe("META_DEVICE", () => {
  it("asks for no scopes — Meta's device flow takes a client id and nothing else", () => {
    expect(META_DEVICE.scope).toBeUndefined();
    expect(META_DEVICE.deviceUrl).toBe("https://auth.meta.com/oidc/device/authorization/");
  });
});
