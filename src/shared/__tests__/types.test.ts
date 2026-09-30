import { describe, expect, it } from "vitest";
import { isRecord } from "../types";

describe("isRecord", () => {
  it("takes a plain object and refuses null, arrays and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ code: 400 })).toBe(true);
    // Two of the four copies this replaced let arrays through. None of their
    // callers wanted one: each reads fields off an object.
    for (const value of [null, undefined, [], [{ code: 400 }], "x", 1, true]) {
      expect(isRecord(value), JSON.stringify(value) ?? "undefined").toBe(false);
    }
  });
});
