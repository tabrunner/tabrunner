import { describe, it, expect, vi, beforeEach } from "vitest";
import { initProviderOriginStrip, providerHosts } from "../origin";
import { PRESETS } from "../presets";

/**
 * The one rule that decides whether a subscription sign-in works at all:
 * Anthropic's CORS gate refuses an OAuth token that arrives with a browser
 * Origin, and the worker's fetch always sends one. These pin the strip itself
 * and, just as importantly, its two boundaries — a user-typed custom endpoint
 * keeps its Origin, and so does the user's own browsing, so the rule can never
 * become a way to hide who we are from a host we were never going to call, nor
 * a way to weaken a page's CSRF defence on a host we were.
 */

const updateSessionRules = vi.fn((_options: unknown) => Promise.resolve());

beforeEach(() => {
  updateSessionRules.mockClear();
  (globalThis as Record<string, unknown>).chrome = {
    declarativeNetRequest: { updateSessionRules },
  };
});

const lastRule = (): chrome.declarativeNetRequest.Rule => {
  const options = updateSessionRules.mock.calls[0]?.[0] as {
    addRules: chrome.declarativeNetRequest.Rule[];
  };
  return options.addRules[0]!;
};

describe("initProviderOriginStrip", () => {
  it("removes Origin and Referer from the known provider hosts", async () => {
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    const rule = lastRule();
    expect(rule.action.requestHeaders).toEqual([
      { header: "origin", operation: "remove" },
      { header: "referer", operation: "remove" },
    ]);
    expect(rule.condition.requestDomains).toContain("api.anthropic.com");
  });

  it("strips only what the worker sent, never what a user's tab sent", async () => {
    // Matched on host alone, the rule would also strip Origin off the user's
    // own browsing of these hosts — github.com reads Origin to know a request
    // came from itself. A worker request belongs to no tab; a page's never can.
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    expect(lastRule().condition.tabIds).toEqual([-1]);
  });

  it("keeps Origin for hosts we were never given — the strip can't be a privacy leak", async () => {
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    const domains = lastRule().condition.requestDomains!;
    // The allowlist is the preset hosts — nothing that ends up there by a
    // user's custom-endpoint input, and nothing unbounded like "*".
    expect(domains).not.toContain("*");
    expect(domains.every((d) => /^[a-z0-9.-]+\.[a-z]+$/.test(d))).toBe(true);
  });
});

describe("providerHosts", () => {
  it("covers every preset that talks to the network", () => {
    // Derived rather than hand-listed precisely so this can't drift: a preset
    // whose host went missing would sign in fine, then fail its first real
    // call with a CORS 401 that reads as a broken account.
    const remote = PRESETS.map((p) => new URL(p.baseUrl).hostname).filter((h) => h.includes("."));
    expect(providerHosts()).toEqual(expect.arrayContaining(remote));
  });

  it("leaves local endpoints out", () => {
    // Ollama is http://localhost — no Origin gate to satisfy, and `localhost`
    // is not a domain a requestDomains condition can name.
    expect(providerHosts().some((h) => h.startsWith("localhost"))).toBe(false);
  });
});
