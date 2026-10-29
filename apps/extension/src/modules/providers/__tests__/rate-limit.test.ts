import { describe, it, expect } from "vitest";
import { parseRateLimitReset, parseUsageLimitBody } from "@providerkit/core";
import { formatResetRelative } from "../rate-limit";

const NOW = Date.parse("2026-08-09T12:00:00Z");

/**
 * A boundary check plus the half that stayed. `parseRateLimitReset` and
 * `parseUsageLimitBody` moved to @providerkit/core, which tests them in depth;
 * what is kept here are the two windows TabRunner reads in production — the
 * Anthropic weekly one and ChatGPT's body-carried reset — so an upstream change
 * that stops naming them fails this build.
 *
 * `formatResetRelative` is not a boundary check: it is the half that could not
 * move, because turning an instant into a phrase needs this extension's locale.
 */

/** The shared parser takes real `Headers`, the way every response carries them. */
function headers(map: Record<string, string>): Headers {
  return new Headers(map);
}

describe("parseRateLimitReset", () => {
  it("names the weekly window when it is the exhausted one", () => {
    const reset = NOW / 1000 + 3 * 86400;
    const result = parseRateLimitReset(
      headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.2",
        "anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 3600),
        "anthropic-ratelimit-unified-7d-utilization": "1",
        "anthropic-ratelimit-unified-7d-reset": String(reset),
      }),
      NOW,
    );
    expect(result.window).toBe("weekly");
    expect(result.resetAtMs).toBe(reset * 1000);
  });
});

describe("parseUsageLimitBody", () => {
  it("reads ChatGPT's body-carried reset and names the monthly window", () => {
    // The observed 429 from the codex backend on a free plan (~29 days).
    const body = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        plan_type: "free",
        resets_at: 1_788_801_754,
        eligible_promo: null,
        resets_in_seconds: 2_501_465,
      },
    });
    expect(parseUsageLimitBody(body, NOW)).toEqual({
      retryAfterMs: 2_501_465_000,
      resetAtMs: NOW + 2_501_465_000,
      window: "monthly",
    });
  });

  it("leaves per-minute throttles windowless — no fake '5-hour' label", () => {
    const body = JSON.stringify({ error: { resets_in_seconds: 45 } });
    expect(parseUsageLimitBody(body, NOW)).toEqual({
      retryAfterMs: 45_000,
      resetAtMs: NOW + 45_000,
    });
  });
});

describe("formatResetRelative", () => {
  it("picks the largest readable unit, appending the absolute time past 90 min", () => {
    expect(formatResetRelative(NOW + 5 * 60_000, NOW)).toBe("in 5 minutes");
    expect(formatResetRelative(NOW + 4 * 3_600_000, NOW)).toMatch(/^in 4 hours \(.+\)$/);
    expect(formatResetRelative(NOW + 3 * 86_400_000, NOW)).toMatch(/^in 3 days \(.+\)$/);
  });

  it("never says zero for a sub-minute wait", () => {
    expect(formatResetRelative(NOW + 10_000, NOW)).toBe("in 1 minute");
  });
});
