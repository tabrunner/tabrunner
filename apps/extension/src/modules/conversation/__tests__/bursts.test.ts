import { describe, it, expect } from "vitest";
import { groupBursts } from "../ui/bursts";
import type { Message, MessageRole } from "../types";

let seq = 0;
const msg = (role: MessageRole, timestamp: number, extra: Partial<Message> = {}): Message => ({
  id: `${role}-${seq++}`,
  role,
  content: "",
  timestamp,
  ...extra,
});

describe("groupBursts", () => {
  it("folds an alternating thought/step run into one burst", () => {
    const items = groupBursts([
      msg("reasoning", 1000, { elapsed: 500 }),
      msg("step", 1100, { tool: "click" }),
      msg("reasoning", 1300, { elapsed: 200 }),
      msg("step", 1400, { tool: "type" }),
      msg("assistant", 2000),
    ]);
    expect(items).toHaveLength(2);
    const [burst] = items;
    if (!burst || burst.kind !== "burst") throw new Error("expected burst");
    expect(burst.steps).toHaveLength(2);
    // The first thought's timestamp marks its end — the burst starts earlier.
    expect(burst.startedAt).toBe(500);
    // The assistant message that ends the run bounds its wall time.
    expect(burst.endedAt).toBe(2000);
    expect(burst.live).toBe(false);
  });

  it("keeps a lone thought or step flat, and thought-only runs too", () => {
    const items = groupBursts([
      msg("reasoning", 1000, { elapsed: 500 }),
      msg("reasoning", 1200, { elapsed: 300 }),
      msg("assistant", 1500),
      msg("step", 1600, { tool: "click" }),
    ]);
    expect(items.every((i) => i.kind === "message")).toBe(true);
    expect(items).toHaveLength(4);
  });

  it("folds a thought-free step run — thinking is not required", () => {
    const items = groupBursts([
      msg("step", 1100, { tool: "click" }),
      msg("step", 1200, { tool: "type" }),
      msg("step", 1300, { tool: "snapshot" }),
    ]);
    const [burst] = items;
    if (!burst || burst.kind !== "burst") throw new Error("expected burst");
    expect(burst.steps).toHaveLength(3);
    expect(burst.startedAt).toBe(1100);
  });

  it("splits bursts on plans and other messages", () => {
    const items = groupBursts([
      msg("reasoning", 1000, { elapsed: 100 }),
      msg("step", 1100, { tool: "click" }),
      msg("plan", 1200),
      msg("reasoning", 1300, { elapsed: 100 }),
      msg("step", 1400, { tool: "type" }),
    ]);
    const bursts = items.filter((i) => i.kind === "burst");
    expect(bursts).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "message", msg: { role: "plan" } });
  });

  it("keeps the trailing burst live for the whole run, not just while a step executes", () => {
    // A think→act gap has no live step; the old flag collapsed the burst
    // there and reopened it on the next tool call — visible flapping mid-run.
    const tail = [msg("reasoning", 1000, { elapsed: 100 }), msg("step", 1100, { tool: "click" })];
    const idle = groupBursts(tail);
    const running = groupBursts(tail, true);
    const burstOf = (items: ReturnType<typeof groupBursts>) => {
      const [burst] = items;
      if (!burst || burst.kind !== "burst") throw new Error("expected burst");
      return burst;
    };
    expect(burstOf(idle).live).toBe(false);
    expect(burstOf(running).live).toBe(true);
  });

  it("a bounded burst never lives, even mid-run", () => {
    const items = groupBursts(
      [
        msg("reasoning", 1000, { elapsed: 100 }),
        msg("step", 1100, { tool: "click" }),
        msg("assistant", 2000),
      ],
      true,
    );
    const [burst] = items;
    if (!burst || burst.kind !== "burst") throw new Error("expected burst");
    expect(burst.live).toBe(false);
  });
});
