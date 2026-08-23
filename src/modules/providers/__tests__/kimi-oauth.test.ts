import { describe, it, expect, vi, afterEach } from "vitest";
import {
  accountFromToken,
  pollForToken,
  refreshCredential,
  requestDeviceCode,
} from "../kimi-oauth";
import type { DevicePrompt } from "../kimi-oauth";
import { SignInError } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A JWT whose payload is `claims` — signature is never checked, only decoded. */
function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${payload}.signature`;
}

function prompt(over: Partial<DevicePrompt> = {}): DevicePrompt {
  return {
    userCode: "UYNP-2B6J",
    verificationUrl: "https://www.kimi.ai/code/authorize_device?user_code=UYNP-2B6J",
    deviceCode: "device-abc",
    intervalMs: 0, // no real waiting in tests
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("requestDeviceCode", () => {
  it("returns the code, the pre-filled url, and the poll cadence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        device_code: "device-abc",
        user_code: "UYNP-2B6J",
        verification_uri: "https://www.kimi.ai/code/authorize_device",
        verification_uri_complete: "https://www.kimi.ai/code/authorize_device?user_code=UYNP-2B6J",
        expires_in: 1800,
        interval: 5,
      }),
    );

    const result = await requestDeviceCode();
    expect(result.userCode).toBe("UYNP-2B6J");
    expect(result.verificationUrl).toContain("user_code=UYNP-2B6J");
    expect(result.intervalMs).toBe(5000);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("surfaces a malformed response instead of a half-built prompt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ device_code: "only-this" }));
    await expect(requestDeviceCode()).rejects.toThrow();
  });
});

describe("pollForToken", () => {
  it("waits through authorization_pending and returns the credential", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(
        json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      );

    const credential = await pollForToken(prompt(), new AbortController().signal);
    expect(credential.accessToken).toBe("at-1");
    expect(credential.refreshToken).toBe("rt-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bakes the refresh skew into expiresAt so readers need no margin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    );
    const before = Date.now();
    const credential = await pollForToken(prompt(), new AbortController().signal);
    // 1h lifetime, 5min skew → ~55min out, never the raw hour.
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("backs off on slow_down, honouring a larger server interval", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "slow_down", interval: 30 }, 400))
      .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", expires_in: 60 }));

    // The second poll must wait the server's 30s, so with fake timers the
    // promise stays pending until we advance past it.
    vi.useFakeTimers();
    try {
      const pending = pollForToken(prompt(), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(29_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ accessToken: "at" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports denial and expiry as distinct outcomes — they need different words", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "access_denied" }, 400));
    await expect(pollForToken(prompt(), new AbortController().signal)).rejects.toMatchObject({
      reason: "denied",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "expired_token" }, 400));
    await expect(pollForToken(prompt(), new AbortController().signal)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("gives up once the code's own lifetime has passed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "authorization_pending" }, 400));
    const expired = prompt({ expiresAt: Date.now() - 1 });
    await expect(pollForToken(expired, new AbortController().signal)).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("stops immediately when the dialog closes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "authorization_pending" }, 400));
    const controller = new AbortController();
    controller.abort();
    const error = await pollForToken(prompt(), controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect((error as SignInError).reason).toBe("cancelled");
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
