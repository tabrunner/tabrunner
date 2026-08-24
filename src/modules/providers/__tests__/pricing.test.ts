import { describe, it, expect } from "vitest";

import { priceOf, tokenCost } from "../pricing";

describe("pricing", () => {
  it("prices an anthropic call with the cache split billed at its own rates", () => {
    // 300 fresh + 9000 read + 700 write at opus-5 list prices:
    // 300·5 + 42·25 + 9000·0.5 + 700·6.25 = 1500 + 1050 + 4500 + 4375 = 11_425 per Mtok
    const cost = tokenCost("claude-opus-5", {
      input: 10000,
      output: 42,
      cacheRead: 9000,
      cacheWrite: 700,
    });
    expect(cost).toBeCloseTo(11425 / 1_000_000, 12);
  });

  it("treats unsplit input as all-fresh", () => {
    // An endpoint that reports no cache detail (or a cacheless model) bills
    // everything at the input rate — the common case must not lose tokens.
    const cost = tokenCost("gpt-5", { input: 1_000_000, output: 0 });
    expect(cost).toBeCloseTo(1.25, 10);
  });

  it("matches dated and suffixed ids by family prefix", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBeDefined();
    expect(priceOf("k3-256k")).toBeDefined();
    // Most specific wins: the minis are not their full-fat siblings.
    expect(priceOf("gpt-5.4-mini")?.input).toBe(0.75);
    expect(priceOf("gpt-5.4")?.input).toBe(2.5);
    expect(priceOf("gpt-4o-mini")?.input).toBe(0.15);
    expect(priceOf("gpt-4o")?.input).toBe(2.5);
    // The codex twin prices with its base; a dated snapshot prices with its own.
    expect(priceOf("gpt-5-codex")?.input).toBe(1.25);
    expect(priceOf("gpt-5-2024-08-06")?.input).toBe(1.25);
  });

  it("returns undefined for an unknown model — no estimate, never a guess", () => {
    expect(tokenCost("some-future-model", { input: 1000, output: 1000 })).toBeUndefined();
    expect(priceOf("llama-3.3-70b-versatile")).toBeUndefined();
    // A near-name is still unknown: a new sibling version must show NO money,
    // never a near-name's price. These have their own, different tiers.
    expect(priceOf("gpt-5.6-sol")).toBeUndefined();
    expect(priceOf("gpt-5-nano")).toBeUndefined();
    expect(priceOf("grok-4.6")).toBeUndefined();
    expect(priceOf("claude-opus-6")).toBeUndefined();
  });

  it("never bills negative fresh input when a gateway over-reports cache", () => {
    const cost = tokenCost("gpt-5", { input: 100, output: 0, cacheRead: 500 });
    // 100 cached at the read rate, 0 fresh — not -400 fresh at the input rate.
    expect(cost).toBeCloseTo((100 * 0.125) / 1_000_000, 15);
  });
});
