import { describe, expect, it } from "vitest";
import { offerZenRead } from "../zen";
import type { ToolDef } from "../types";

const snapshot: ToolDef = {
  name: "snapshot",
  description: "See the page",
  params: { type: "object", properties: {} },
};

const freeZen = { id: "opencode", model: "big-pickle" };

describe("offerZenRead", () => {
  it("adds a decoy read after the real tools on a free Zen model", () => {
    // Without a tool named `read` the free tier answers 403 FreeTierError, and
    // TabRunner has no tool by that name.
    const offered = offerZenRead(freeZen, [snapshot]);
    expect(offered.map((t) => t.name)).toEqual(["snapshot", "read"]);
    expect(offered[1]?.description).toContain("Never call it");
  });

  it("adds it to a call with no tools of its own, like the titler", () => {
    expect(
      offerZenRead({ id: "opencode", model: "glm-5.3-flash-free" }, []).map((t) => t.name),
    ).toEqual(["read"]);
  });

  it("does not add a second one when the call already has a read", () => {
    const own: ToolDef = { ...snapshot, name: "read" };
    expect(offerZenRead(freeZen, [own])).toEqual([own]);
  });

  it("leaves paid Zen models, Go and every other provider alone", () => {
    const tools = [snapshot];
    expect(offerZenRead({ id: "opencode", model: "claude-sonnet-5-5" }, tools)).toBe(tools);
    expect(offerZenRead({ id: "opencode-go", model: "mimo-v2.6-flash-free" }, tools)).toBe(tools);
    expect(offerZenRead({ id: "openai", model: "big-pickle" }, tools)).toBe(tools);
  });
});
