import { describe, it, expect } from "vitest";
import { toolHint, displacedHint } from "../ui/tool-labels";
import { stepHint } from "../step-hint";
import { fitScale } from "../ui/image";

describe("toolHint", () => {
  it("reduces a URL to its host, without www", () => {
    expect(toolHint("navigate", { url: "https://www.example.com/a/b?c=d" })).toBe("example.com");
  });

  it("falls back to the raw value when the URL will not parse", () => {
    expect(toolHint("navigate", { url: "example.com/path" })).toBe("example.com/path");
  });

  it("truncates long typed text so a row stays one line", () => {
    const hint = toolHint("type", { text: "x".repeat(200) });
    expect(hint).toHaveLength(48);
    expect(hint?.endsWith("…")).toBe(true);
  });

  it("shows where a fill landed and what it wrote", () => {
    expect(toolHint("fill", { ref: "e12", text: "93619-155" })).toBe("e12: 93619-155");
    // Clearing a field carries no text — the ref alone is the trace.
    expect(toolHint("fill", { ref: "e12", text: "" })).toBe("e12");
  });

  it("shows the code an evaluate ran — the code is the action", () => {
    expect(toolHint("evaluate", { expression: "document.title" })).toBe("document.title");
  });

  it("prefers the model's intent over the locator a human cannot read", () => {
    expect(toolHint("click", { ref: "e27", intent: "the account menu" })).toBe("the account menu");
    expect(toolHint("evaluate", { expression: "document.title", intent: "the cart total" })).toBe(
      "the cart total",
    );
  });

  it("replaces only the locator — a readable value keeps its place", () => {
    expect(toolHint("fill", { ref: "e12", text: "93619-155", intent: "the ZIP code" })).toBe(
      "the ZIP code: 93619-155",
    );
  });

  it("never hides where the browser went behind the model's phrase", () => {
    expect(
      toolHint("navigate", {
        url: "https://www.amazon.com/gp/css/order-history",
        intent: "orders",
      }),
    ).toBe("amazon.com: orders");
  });

  it("keeps the mechanical hint when the model skips the intent", () => {
    expect(toolHint("click", { ref: "e27", intent: "  " })).toBe("e27");
    expect(toolHint("click", { ref: "e27" })).toBe("e27");
    expect(toolHint("navigate", { url: "https://example.com" })).toBe("example.com");
  });

  it("never lets a stray intent displace an argument that already reads well", () => {
    // press_key declares no intent (agent/prompt.ts) — one arriving anyway is
    // noise, and "Enter" already says everything the row needs.
    expect(toolHint("press_key", { key: "Enter", intent: "submit the form" })).toBe("Enter");
  });

  it("pairs a typed value with the field it went into, the way fill does", () => {
    // `type` gained an intent when walkthroughs did: a documented typing step
    // has no other source for the field's name, and the row reads better too.
    expect(toolHint("type", { text: "gus@example.com", intent: "the email field" })).toBe(
      "the email field: gus@example.com",
    );
    expect(toolHint("type", { text: "gus@example.com" })).toBe("gus@example.com");
  });

  it("names a tab switch by its result, never its id — the id is the drawer's trace", () => {
    expect(toolHint("switch_tab", { tab_id: 42 })).toBeUndefined();
    expect(toolHint("group_tab", { tab_id: 42 })).toBeUndefined();
    expect(displacedHint("switch_tab", { tab_id: 42 })).toBe("#42");
    expect(displacedHint("group_tab", { tab_id: 42 })).toBe("#42");
  });

  it("reads a chord as the chord", () => {
    expect(toolHint("press_key", { key: "a", modifiers: ["Mod"] })).toBe("Mod+a");
    expect(toolHint("press_key", { key: "Enter" })).toBe("Enter");
  });

  it("names a find by its query and a go_back by its destination", () => {
    expect(toolHint("find", { query: "Total due" })).toBe("Total due");
    expect(toolHint("go_back", { intent: "the search results" })).toBe("the search results");
    expect(toolHint("go_back", {})).toBeUndefined();
  });

  it("treats an opened tab like a navigation — the host leads", () => {
    expect(
      toolHint("open_tab", { url: "https://www.amazon.com/x", intent: "the comparison" }),
    ).toBe("amazon.com: the comparison");
  });

  it("has no hint for tools that take no distinguishing argument", () => {
    expect(toolHint("snapshot", {})).toBeUndefined();
    expect(toolHint("screenshot", {})).toBeUndefined();
  });

  it("ignores arguments of the wrong type instead of printing them", () => {
    expect(toolHint("click", { ref: 12 })).toBeUndefined();
    expect(toolHint("scroll_down", { amount: "lots" })).toBeUndefined();
    expect(toolHint("scroll_down", { amount: 600 })).toBe("600px");
  });

  it("has no hint without a tool or arguments", () => {
    expect(toolHint(undefined, { url: "https://example.com" })).toBeUndefined();
    expect(toolHint("navigate", undefined)).toBeUndefined();
  });
});

/**
 * toolHint (panel rows) and stepHint (transcript notes / read_history) are the
 * same switch on opposite sides of the runtime boundary — they drifted apart
 * twice already. This is the mechanical guard the file comment only asks for.
 *
 * switch_tab/group_tab are the deliberate exception: the panel lets the result
 * name the tab (the id moves to the drawer), while the transcript keeps the id —
 * a transcript that only said "Gmail" loses the handle once the tab is gone.
 */
describe("toolHint / stepHint parity", () => {
  const CASES: [string, Record<string, unknown>][] = [
    ["navigate", { url: "https://www.example.com/a" }],
    ["navigate", { url: "https://www.example.com/a", intent: "the search results" }],
    ["click", { ref: "e3" }],
    ["click", { ref: "e3", intent: "the account menu" }],
    ["fill", { ref: "e3", text: "hello" }],
    ["fill", { ref: "e3", text: "hello", intent: "the email field" }],
    ["evaluate", { expression: "document.title", intent: "the page title" }],
    ["type", { text: "hello" }],
    ["press_key", { key: "Enter" }],
    ["press_key", { key: "a", modifiers: ["Mod"] }],
    ["find", { query: "Total due" }],
    ["go_back", { intent: "the listing" }],
    ["open_tab", { url: "https://www.example.com/x", intent: "the comparison" }],
    ["scroll_down", { amount: 800 }],
    ["scroll_up", { amount: 800 }],
    ["evaluate", { expression: "document.title" }],
    ["read_network_requests", { url_filter: "api" }],
    ["snapshot", {}],
    ["screenshot", {}],
    ["read_history", { from: 0 }],
    ["read_console_messages", { only_errors: true }],
    ["ask_user", { question: "Ship it?" }],
  ];

  it("both twins hint — or stay silent — for the same tools", () => {
    for (const [tool, args] of CASES) {
      expect(Boolean(stepHint(tool, args)), `stepHint(${tool})`).toBe(
        Boolean(toolHint(tool, args)),
      );
    }
  });

  it("only the tab tools diverge — the transcript keeps the id the panel drops", () => {
    for (const tool of ["switch_tab", "group_tab", "close_tab"] as const) {
      const args = { tab_id: 42 };
      expect(toolHint(tool, args)).toBeUndefined();
      expect(stepHint(tool, args)).toBe("#42");
    }
  });
});

describe("fitScale", () => {
  it("shrinks by the longest edge", () => {
    expect(fitScale(3000, 1500, 1500)).toBe(0.5);
    expect(fitScale(1500, 3000, 1500)).toBe(0.5);
  });

  it("never upscales a small image", () => {
    expect(fitScale(400, 300, 1500)).toBe(1);
  });
});
