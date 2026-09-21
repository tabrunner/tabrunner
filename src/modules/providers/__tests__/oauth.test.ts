import { describe, it, expect, vi, afterEach } from "vitest";
import { captureRedirect, generatePKCE, postToken, randomState, toCredential } from "../oauth";
import { ProviderError, SignInError } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TOKENS = { access_token: "at", refresh_token: "rt", expires_in: 3600 };

afterEach(() => vi.restoreAllMocks());

describe("generatePKCE", () => {
  it("produces a verifier whose S256 challenge matches, both base64url", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32-byte digest, unpadded

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });
});

describe("randomState", () => {
  it("is 128 bits of hex, and never repeats", () => {
    expect(randomState()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomState()).not.toBe(randomState());
  });
});

describe("postToken", () => {
  it("takes a token pair as success whatever the status says", async () => {
    // Anthropic answers 429 for a plan over its usage limit AND hands back the
    // tokens — throwing there would force a pointless re-login.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(TOKENS, 429));
    await expect(postToken("https://x/token", {}, { encode: "json" })).resolves.toMatchObject({
      access_token: "at",
    });
  });

  it("fails a 429 that carries no token — nobody is signed in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "rate_limited" }, 429));
    const error = await postToken("https://x/token", {}, { encode: "json" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(429);
    // A throttled token endpoint says nothing about the account's usage, and
    // blaming an untouched plan is worse than saying nothing.
    expect((error as ProviderError).message).toMatch(/isn't about your plan/i);
  });

  it("turns Retry-After into the wait it actually is", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "45" },
      }),
    );
    await expect(postToken("https://x/token", {}, { encode: "json" })).rejects.toThrow(/45s/);
  });

  it("surfaces the vendor's own reason on a plain failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ error_description: "code already used" }, 400),
    );
    await expect(postToken("https://x/token", {}, { encode: "form" })).rejects.toThrow(
      /code already used/,
    );
  });

  it("hands back 4xx bodies when the caller reads them — the device poll's pending answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ error: "authorization_pending" }, 400),
    );
    await expect(
      postToken("https://x/token", {}, { encode: "form", allowErrorBody: true }),
    ).resolves.toMatchObject({ error: "authorization_pending" });
  });

  it("encodes json or form per the vendor's endpoint", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(TOKENS));
    await postToken("https://x/token", { a: "1" }, { encode: "json" });
    await postToken("https://x/token", { a: "1" }, { encode: "form" });
    expect(mock.mock.calls[0]?.[1]?.body).toBe('{"a":"1"}');
    expect(mock.mock.calls[1]?.[1]?.body).toBe("a=1");
  });
});

describe("captureRedirect", () => {
  const TAB_ID = 42;
  type Updated = (id: number, info: { url?: string }) => void;

  /**
   * chrome.tabs holding one listener per event. `remove` rejects the way Chrome
   * does for a dead id, so a call the flow should not have made shows up as an
   * unhandled rejection — the very bug these cases guard.
   */
  const stubTabs = () => {
    const listeners: { updated?: Updated; removed?: (id: number) => void } = {};
    const remove = vi.fn(() => Promise.reject(new Error(`No tab with id: ${TAB_ID}.`)));
    (globalThis as Record<string, unknown>).chrome = {
      tabs: {
        create: () => Promise.resolve({ id: TAB_ID }),
        remove,
        onUpdated: {
          addListener: (fn: Updated) => (listeners.updated = fn),
          removeListener: () => (listeners.updated = undefined),
        },
        onRemoved: {
          addListener: (fn: (id: number) => void) => (listeners.removed = fn),
          removeListener: () => (listeners.removed = undefined),
        },
      },
    };
    return { listeners, remove };
  };

  /** Start the flow and let tabs.create resolve — until then it has no tab id. */
  const start = async (over: { state?: string } = { state: "st" }) => {
    const stub = stubTabs();
    const pending = captureRedirect({
      authorizeUrl: "https://vendor.example/authorize",
      redirectUri: "http://localhost:1455/callback",
      ...over,
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { ...stub, pending };
  };

  it("cancels when the user closes the approve tab, without closing it again", async () => {
    const { listeners, remove, pending } = await start();

    listeners.removed?.(TAB_ID);

    await expect(pending).rejects.toThrow(SignInError);
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    // The tab is already gone; asking Chrome to close it again is the uncaught
    // "No tab with id" the panel was reporting.
    expect(remove).not.toHaveBeenCalled();
  });

  it("closes the approve tab once the code is captured", async () => {
    const { listeners, remove, pending } = await start();

    listeners.updated?.(TAB_ID, { url: "http://localhost:1455/callback?state=st&code=abc" });

    await expect(pending).resolves.toBe("abc");
    // A rejecting remove (tab died first) must not break a completed sign-in.
    expect(remove).toHaveBeenCalledWith(TAB_ID);
  });

  it("refuses a callback carrying the wrong state", async () => {
    const { listeners, pending } = await start();

    listeners.updated?.(TAB_ID, { url: "http://localhost:1455/callback?state=other&code=abc" });

    await expect(pending).rejects.toMatchObject({ reason: "denied" });
  });

  it("takes a stateless callback when no state was issued", async () => {
    // OpenRouter's authorize endpoint accepts no state to round-trip. The tab
    // id still binds the answer to the request we made, and PKCE still binds
    // the code to a verifier that never left this worker.
    const { listeners, pending } = await start({});

    listeners.updated?.(TAB_ID, { url: "http://localhost:1455/callback?code=abc" });

    await expect(pending).resolves.toBe("abc");
  });
});

describe("toCredential", () => {
  it("bakes the refresh skew into expiresAt so readers need no margin", () => {
    const before = Date.now();
    const credential = toCredential(TOKENS);
    // 1h lifetime, 5min skew → ~55min out, never the raw hour.
    expect(credential.expiresAt).toBeGreaterThan(before + 54 * 60_000);
    expect(credential.expiresAt).toBeLessThan(before + 56 * 60_000);
  });

  it("throws on a half-built credential instead of storing one", () => {
    expect(() => toCredential({ access_token: "at" })).toThrow();
  });
});
