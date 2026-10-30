import { describe, it, expect } from "vitest";
import { overBudget, MAX_TOTAL_BYTES } from "../store";
import type { Recording, RecordingStatus } from "../types";

/**
 * The eviction rule, tested without a database — which is the whole reason it
 * is a pure function. Getting this wrong either lets recordings own the disk or
 * deletes the one the user is still writing.
 */
function rec(id: string, bytes: number, startedAt: number, status: RecordingStatus): Recording {
  return {
    id,
    conversationId: "c1",
    title: id,
    status,
    startedAt,
    frames: 1,
    bytes,
    sites: [],
    armedAtStep: 0,
  };
}

describe("overBudget", () => {
  it("evicts nothing while the total fits", () => {
    expect(overBudget([rec("a", 10, 1, "complete"), rec("b", 10, 2, "complete")], 100)).toEqual([]);
  });

  it("evicts oldest first, and only as many as it takes", () => {
    const all = [
      rec("newest", 60, 3, "complete"),
      rec("oldest", 60, 1, "complete"),
      rec("middle", 60, 2, "complete"),
    ];
    expect(overBudget(all, 150)).toEqual(["oldest"]);
  });

  it("never evicts a recording still being written", () => {
    const all = [rec("live", 200, 1, "recording"), rec("done", 200, 2, "complete")];
    expect(overBudget(all, 100)).toEqual(["done"]);
  });

  it("gives up rather than deleting a live recording it cannot get under the cap", () => {
    expect(overBudget([rec("live", 999, 1, "recording")], 100)).toEqual([]);
  });

  it("defaults to the global cap", () => {
    expect(overBudget([rec("a", MAX_TOTAL_BYTES + 1, 1, "complete")])).toEqual(["a"]);
  });
});
