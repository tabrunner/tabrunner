import { describe, it, expect } from "vitest";
import { parseClaudeUsage, parseChatGptUsage, parseKimiUsage, supportsUsage } from "../usage";

describe("supportsUsage", () => {
  it("covers exactly the OAuth subscription presets", () => {
    expect(supportsUsage("claude")).toBe(true);
    expect(supportsUsage("chatgpt")).toBe(true);
    expect(supportsUsage("kimi-plan")).toBe(true);
    // Keyed variants and everyone else have no subscription windows.
    expect(supportsUsage("anthropic")).toBe(false);
    expect(supportsUsage("openai")).toBe(false);
    expect(supportsUsage("kimi")).toBe(false);
    expect(supportsUsage("custom-xyz")).toBe(false);
  });
});

describe("parseClaudeUsage", () => {
  it("reads the 5-hour and weekly windows with their resets", () => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 37, resets_at: "2026-08-09T17:00:00.000000+00:00" },
        seven_day: { utilization: 13.4, resets_at: "2026-08-14T00:59:59.951713+00:00" },
        seven_day_opus: { utilization: 5, resets_at: "2026-08-14T00:59:59.951713+00:00" },
      }),
    ).toEqual({
      fiveHour: { usedPercent: 37, resetsAtMs: Date.parse("2026-08-09T17:00:00.000000+00:00") },
      weekly: { usedPercent: 13.4, resetsAtMs: Date.parse("2026-08-14T00:59:59.951713+00:00") },
    });
  });

  it("omits windows that arrive malformed", () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 3 } })).toEqual({
      weekly: { usedPercent: 3 },
    });
    expect(parseClaudeUsage("nope")).toEqual({});
  });
});

describe("parseChatGptUsage", () => {
  it("maps primary/secondary windows to 5h/weekly and keeps the plan", () => {
    expect(
      parseChatGptUsage({
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 45, resets_at: "2026-08-09T17:00:00Z" },
          secondary_window: { used_percent: 7, resets_at: "2026-08-15T00:00:00Z" },
        },
      }),
    ).toEqual({
      plan: "plus",
      fiveHour: { usedPercent: 45, resetsAtMs: Date.parse("2026-08-09T17:00:00Z") },
      weekly: { usedPercent: 7, resetsAtMs: Date.parse("2026-08-15T00:00:00Z") },
    });
  });

  it("accepts epoch-second resets and missing windows", () => {
    expect(
      parseChatGptUsage({
        rate_limit: { primary_window: { used_percent: 100, resets_at: 1_786_000_000 } },
      }),
    ).toEqual({ fiveHour: { usedPercent: 100, resetsAtMs: 1_786_000_000_000 } });
  });
});

describe("parseKimiUsage", () => {
  it("reads string numbers from the 5h detail and weekly usage blocks", () => {
    expect(
      parseKimiUsage({
        user: { membership: { level: "allegretto" } },
        usage: { limit: "1000", used: "120", resetTime: "2026-08-15T00:00:00+08:00" },
        limits: [
          {
            window: { duration: 300, timeUnit: "MINUTE" },
            detail: { limit: "100", used: "28", resetTime: "2026-08-09T17:00:00+08:00" },
          },
        ],
      }),
    ).toEqual({
      plan: "allegretto",
      fiveHour: { usedPercent: 28, resetsAtMs: Date.parse("2026-08-09T17:00:00+08:00") },
      weekly: { usedPercent: 12, resetsAtMs: Date.parse("2026-08-15T00:00:00+08:00") },
    });
  });

  it("derives used percent from remaining when used is absent", () => {
    const { weekly } = parseKimiUsage({ usage: { limit: "500", remaining: "250" } });
    expect(weekly).toEqual({ usedPercent: 50 });
  });

  it("falls back to subType for the plan and skips unreadable windows", () => {
    expect(parseKimiUsage({ subType: "moderato", limits: "later" })).toEqual({
      plan: "moderato",
    });
  });
});
