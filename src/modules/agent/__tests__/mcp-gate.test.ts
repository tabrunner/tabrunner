import { describe, expect, it } from "vitest";
import { isGatedTool } from "../loop";

describe("isGatedTool", () => {
  it("keeps every static gate exactly as it was", () => {
    for (const name of [
      "navigate",
      "go_back",
      "open_tab",
      "close_tab",
      "click",
      "type",
      "fill",
      "evaluate",
      "press_key",
      "scroll_down",
      "scroll_up",
      "schedule_task",
    ]) {
      expect(isGatedTool(name)).toBe(true);
    }
  });

  it("still leaves reads and bookkeeping free", () => {
    for (const name of [
      "snapshot",
      "read_network_requests",
      "plan",
      "remember",
      "skill",
      "done",
      "cancel_schedule",
    ]) {
      expect(isGatedTool(name)).toBe(false);
    }
  });

  it("gates every remote tool by prefix, whatever a server claims", () => {
    expect(isGatedTool("mcp__aboard__search")).toBe(true);
    expect(isGatedTool("mcp__a__b__c")).toBe(true);
    // The Anthropic OAuth wire prefixes tool names with custom_, but the
    // adapter strips that before replay — the loop only ever judges bare names.
  });

  it("does not mistake near-prefix names for remote ones", () => {
    expect(isGatedTool("mcp_")).toBe(false);
    expect(isGatedTool("mcpX__x")).toBe(false);
  });
});
