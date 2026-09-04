import { describe, it, expect } from "vitest";
import { parseToolArgs } from "@providerkit/core";

/**
 * A boundary check, not a copy of the parser's suite. `parseToolArgs` lives in
 * @providerkit/core now and is tested there in depth; what these cases hold is
 * the handful of shapes TabRunner learned from real runs, so a change upstream
 * that loses one fails this build rather than a user's tool call.
 */
describe("parseToolArgs — the shapes real runs produced here", () => {
  it("salvages a done summary cut mid-string — the whole answer survives", () => {
    const raw = '{"summary":"Opened the page, filled the form, and submi';
    expect(parseToolArgs(raw)).toEqual({
      summary: "Opened the page, filled the form, and submi",
    });
  });

  it("heals a model that escaped its accents twice", () => {
    // Reached the user as `atenção` before this: a correct parse
    // still leaves the six literal characters standing.
    expect(parseToolArgs('{"text":"aten\\\\u00e7\\\\u00e3o"}')).toEqual({ text: "atenção" });
  });

  it("keeps the fields that closed before the cut, drops the half-written number", () => {
    expect(parseToolArgs('{"url":"https://x.com","n":3')).toEqual({ url: "https://x.com" });
  });
});
