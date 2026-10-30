import { describe, it, expect } from "vitest";
import { selectTip } from "../scheduler";
import { TIPS } from "../registry";

const stats = (opens: number, shown: Record<string, number> = {}) => ({ opens, shown });

describe("selectTip", () => {
  it("picks from the registry when nothing was ever shown", () => {
    const id = selectTip(stats(1));
    expect(TIPS.some((tip) => tip.id === id)).toBe(true);
  });

  it("excludes a tip still inside its cooldown", () => {
    // escStop shown this very open; with cooldown 4 it must not come back.
    expect(selectTip(stats(10, { escStop: 10 }))).not.toBe("escStop");
  });

  it("readmits a tip once the cooldown has passed", () => {
    const tip = TIPS[0];
    // Everything else shown this very open (ineligible); the target sits
    // exactly at its cooldown edge (ago == cooldownOpens) — back in rotation.
    const shown = Object.fromEntries(TIPS.map(({ id }) => [id, 10]));
    shown[tip.id] = 10 - tip.cooldownOpens;
    expect(selectTip(stats(10, shown))).toBe(tip.id);
  });

  it("least-recently-shown wins among the eligible — a fair round-robin, not random", () => {
    // All cooled down except the rest; escStop is 10 opens stale,
    // historyRecall exactly at its edge (10-6=4 >= 4). The staler one wins.
    // (Never-shown tips are Infinity-stale, so this test shows every tip.)
    const shown = Object.fromEntries(TIPS.map(({ id }) => [id, 10]));
    Object.assign(shown, { escStop: 0, historyRecall: 6 });
    expect(selectTip(stats(10, shown))).toBe("escStop");
  });

  it("returns null when every tip is cooling down", () => {
    const shown = Object.fromEntries(TIPS.map((tip) => [tip.id, 10]));
    expect(selectTip(stats(10, shown))).toBeNull();
  });

  it("ignores ids the registry no longer knows", () => {
    const id = selectTip(stats(1, { retiredTip: 1 }));
    expect(TIPS.some((tip) => tip.id === id)).toBe(true);
  });
});
