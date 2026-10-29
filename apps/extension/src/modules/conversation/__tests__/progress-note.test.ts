import { describe, expect, it } from "vitest";

import { buildProgressNote } from "../progress-note";
import type { ProgressStep } from "../progress-note";

const step = (partial: Partial<ProgressStep>): ProgressStep => ({
  tool: "snapshot",
  summary: "Captured 154 elements",
  ok: true,
  ...partial,
});

describe("buildProgressNote", () => {
  it("returns null when the run died before its first step", () => {
    expect(buildProgressNote([], "boom")).toBeNull();
  });

  it("lists each step once, with the distinguishing argument", () => {
    const note = buildProgressNote(
      [
        step({
          tool: "navigate",
          summary: "Navigated successfully",
          args: { url: "https://www.reddit.com/r/all" },
        }),
        step({ tool: "click", summary: "Clicked at (420, 300)", args: { ref: "e50" } }),
      ],
      "Provider error: 429",
    );

    expect(note).toContain("1. Navigated successfully · reddit.com");
    expect(note).toContain("2. Clicked at (420, 300) · e50");
  });

  it("collapses consecutive repeats into a count", () => {
    const note = buildProgressNote([step({}), step({}), step({})], "boom");
    expect(note).toContain("1. Captured 154 elements ×3");
    expect(note).not.toContain("2.");
  });

  it("keeps the head and the tail when the run was long", () => {
    const steps = Array.from({ length: 30 }, (_, i) =>
      step({ tool: "click", summary: `Clicked at (${i}, 0)`, args: { ref: `e${i}` } }),
    );
    const note = buildProgressNote(steps, "boom")!;
    const lines = note.split("\n").filter((l) => /^\d+\./.test(l));

    expect(lines).toHaveLength(18);
    expect(lines[0]).toContain("e0");
    expect(lines[3]).toContain("13 earlier steps");
    expect(lines[17]).toContain("e29");
  });

  it("closes with the failure and the resume instruction", () => {
    const note = buildProgressNote([step({})], "x".repeat(400))!;

    expect(note).toContain("This run was interrupted before it could finish.");
    expect(note).toContain(`It then failed: ${"x".repeat(299)}…`);
    expect(note).toContain("read_history");
  });

  it("names the user's stop instead of a failure, and leaves the next move to them", () => {
    const note = buildProgressNote([step({})])!;

    expect(note).toContain("The user stopped this run before it finished.");
    expect(note).not.toContain("It then failed");
    // Offered, not ordered — a stop often means "do something else".
    expect(note).toContain("read_history");
    expect(note).toContain("decides what happens");
  });
});
