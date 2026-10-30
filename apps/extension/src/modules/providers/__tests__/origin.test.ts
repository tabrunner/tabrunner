import { describe, it, expect, vi, beforeEach } from "vitest";
import { OPENCODE_CLI_USER_AGENT } from "@providerkit/core";
import { initProviderOriginStrip, providerHosts, stampAntigravityUserAgent } from "../origin";
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

type Rule = chrome.declarativeNetRequest.Rule;

const addedRules = (call = 0): Rule[] =>
  (updateSessionRules.mock.calls[call]?.[0] as { addRules: Rule[] }).addRules;

const lastRule = (): Rule => addedRules()[0]!;

const userAgentRules = (rules: Rule[]) =>
  rules.filter((r) => r.action.requestHeaders?.some((h) => h.header === "user-agent"));

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

describe("user agent stamping", () => {
  it("gives OpenCode's UA to Zen calls, which the free tier requires", async () => {
    // Chromium ignores a User-Agent set on fetch, so the rule is the only way.
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    const zen = userAgentRules(addedRules()).find((r) => r.condition.urlFilter);
    expect(zen?.action.requestHeaders).toEqual([
      { header: "user-agent", operation: "set", value: OPENCODE_CLI_USER_AGENT },
    ]);
    // Our own calls only, like the Origin rule.
    expect(zen?.condition.tabIds).toEqual([-1]);
  });

  it("leaves OpenCode Go asking as itself", async () => {
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    const filter = userAgentRules(addedRules()).find((r) => r.condition.urlFilter)?.condition
      .urlFilter;
    expect(filter).toBe("||opencode.ai/zen/v1/");
    // The filter is a prefix of Zen's path, and Go's path is not under it.
    expect("opencode.ai/zen/go/v1/chat/completions".startsWith("opencode.ai/zen/v1/")).toBe(false);
  });

  it("starts Antigravity on its IDE UA, which is what sign-in sends", async () => {
    initProviderOriginStrip();
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledOnce());

    const rule = userAgentRules(addedRules()).find((r) => r.condition.requestDomains);
    expect(rule?.action.requestHeaders?.[0]?.value).toContain("antigravity/ide/");
    expect(rule?.condition.requestDomains).toEqual([
      "cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
    ]);
  });

  it("restamps Antigravity per model: gemini-4-argon is the CLI's, the rest the IDE's", async () => {
    await stampAntigravityUserAgent("gemini-4-argon");
    await stampAntigravityUserAgent("gemini-3.8-flash");

    expect(addedRules(0)[0]?.action.requestHeaders?.[0]?.value).toContain("antigravity/cli/");
    expect(addedRules(1)[0]?.action.requestHeaders?.[0]?.value).toContain("antigravity/ide/");
    // It replaces its own rule rather than piling up a second one.
    expect(updateSessionRules.mock.calls[1]?.[0]).toMatchObject({ removeRuleIds: [3] });
  });

  it("lets the call go out when the rule cannot be set", async () => {
    updateSessionRules.mockRejectedValueOnce(new Error("rule limit"));
    await expect(stampAntigravityUserAgent("gemini-4-argon")).resolves.toBeUndefined();
  });
});

describe("providerHosts", () => {
  it("names Antigravity's token and fallback hosts, which no preset's baseUrl does", () => {
    expect(providerHosts()).toEqual(
      expect.arrayContaining(["oauth2.googleapis.com", "cloudcode-pa.googleapis.com"]),
    );
  });

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
