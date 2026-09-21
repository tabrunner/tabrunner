import { describe, it, expect, vi, afterEach } from "vitest";
import { pollDeviceToken, requestDeviceCode } from "../device-code";
import type { DeviceEndpoint, DevicePrompt } from "../device-code";
import { SignInError } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ENDPOINT: DeviceEndpoint = {
  clientId: "client-1",
  deviceUrl: "https://auth.example.com/device",
  tokenUrl: "https://auth.example.com/token",
  encode: "form",
};

function prompt(over: Partial<DevicePrompt> = {}): DevicePrompt {
  return {
    userCode: "UYNP-2B6J",
    verificationUrl: "https://example.com/device?user_code=UYNP-2B6J",
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
        verification_uri: "https://example.com/device",
        verification_uri_complete: "https://example.com/device?user_code=UYNP-2B6J",
        expires_in: 1800,
        interval: 5,
      }),
    );

    const result = await requestDeviceCode(ENDPOINT);
    expect(result.userCode).toBe("UYNP-2B6J");
    expect(result.verificationUrl).toContain("user_code=UYNP-2B6J");
    expect(result.intervalMs).toBe(5000);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("sends the scope and the vendor's extra fields on the authorization request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        device_code: "d",
        user_code: "U",
        verification_uri: "https://example.com/device",
        expires_in: 600,
      }),
    );

    await requestDeviceCode({ ...ENDPOINT, scope: "api:access", extra: { referrer: "tabrunner" } });
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain("scope=api%3Aaccess");
    expect(body).toContain("referrer=tabrunner");
  });

  it("falls back to a default lifetime when the vendor omits expires_in", async () => {
    // Meta's device authorization leaves it out; a NaN deadline would make the
    // poll give up on its very first pass.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ device_code: "d", user_code: "U", verification_uri: "https://example.com/device" }),
    );
    const result = await requestDeviceCode(ENDPOINT);
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 60_000);
  });

  it("refuses a verification url that isn't http(s)", async () => {
    // This value comes off the network and goes straight to chrome.tabs.create —
    // a javascript: URL there would let a sign-in response pick what runs.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        device_code: "d",
        user_code: "U",
        verification_uri: "javascript:alert(1)",
        expires_in: 600,
      }),
    );
    await expect(requestDeviceCode(ENDPOINT)).rejects.toThrow();
  });

  it("surfaces a malformed response instead of a half-built prompt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ device_code: "only-this" }));
    await expect(requestDeviceCode(ENDPOINT)).rejects.toThrow();
  });
});

describe("pollDeviceToken", () => {
  it("waits through authorization_pending and returns the token body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(
        json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      );

    const body = await pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal);
    expect(body.access_token).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("accepts a 200 that carries an error — GitHub answers pending that way", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 200))
      .mockResolvedValueOnce(json({ access_token: "gho_1", token_type: "bearer" }, 200));

    const body = await pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal);
    expect(body.access_token).toBe("gho_1");
  });

  it("backs off on slow_down, honouring a larger server interval", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "slow_down", interval: 30 }, 400))
      .mockResolvedValueOnce(json({ access_token: "at", refresh_token: "rt", expires_in: 60 }));

    // The second poll must wait the server's 30s, so with fake timers the
    // promise stays pending until we advance past it.
    vi.useFakeTimers();
    try {
      const pending = pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(29_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ access_token: "at" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports denial and expiry as distinct outcomes — they need different words", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "access_denied" }, 400));
    await expect(
      pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "denied" });

    // xAI words the same refusal differently; both are the user saying no.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ error: "authorization_denied" }, 400),
    );
    await expect(
      pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "denied" });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "expired_token" }, 400));
    await expect(
      pollDeviceToken(ENDPOINT, prompt(), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("gives up once the code's own lifetime has passed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "authorization_pending" }, 400));
    const expired = prompt({ expiresAt: Date.now() - 1 });
    await expect(
      pollDeviceToken(ENDPOINT, expired, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("stops immediately when the dialog closes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "authorization_pending" }, 400));
    const controller = new AbortController();
    controller.abort();
    const error = await pollDeviceToken(ENDPOINT, prompt(), controller.signal).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SignInError);
    expect((error as SignInError).reason).toBe("cancelled");
  });
});
