import { describe, it, expect } from "vitest";

import { formatDuration, formatMoney } from "../format";

describe("formatMoney", () => {
  it("keeps two decimals where they say something", () => {
    expect(formatMoney(1.5)).toBe("$1.50");
    expect(formatMoney(0.04)).toBe("$0.04");
  });

  it("keeps the thousandth while a sub-cent run has one", () => {
    expect(formatMoney(0.004)).toBe("$0.004");
    expect(formatMoney(0.001)).toBe("$0.001");
  });

  it("prints a real zero as a zero, never as a tiny positive charge", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(0.0009)).toBe("$0.00");
  });
});

describe("formatDuration", () => {
  it("reads under a minute in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("reads under an hour in minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(478_000)).toBe("7m 58s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("reads an hour-plus as hours, never as a three-digit minute", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    // The figure the panel once printed as "127m 58s".
    expect(formatDuration(7_678_000)).toBe("2h 7m 58s");
    expect(formatDuration(86_399_000)).toBe("23h 59m 59s");
  });

  it("caps at days once a run crosses them", () => {
    expect(formatDuration(86_400_000)).toBe("1d 0h");
    expect(formatDuration(200_000_000)).toBe("2d 7h");
  });

  it("never goes negative", () => {
    expect(formatDuration(-1)).toBe("0s");
  });
});
