import { describe, it, expect, vi, afterEach } from "vitest";
import { SignInError } from "@providerkit/core/auth";
import { captureRedirect } from "../oauth";

afterEach(() => vi.restoreAllMocks());

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
