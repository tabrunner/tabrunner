import { describe, it, expect } from "vitest";
import { formatSuccessSummary } from "../tools";

describe("formatSuccessSummary", () => {
  it("reports a click as the confirmation it is — coordinates are for the driver", () => {
    expect(formatSuccessSummary("click", { x: 632, y: 411 })).toBe("Clicked");
  });

  it("says where a navigation landed — the host is the row's only trace", () => {
    expect(
      formatSuccessSummary("navigate", { url: "https://www.amazon.com/gp/css/order-history" }),
    ).toBe("Navigated to amazon.com");
  });

  it("keeps the raw value when the URL will not parse", () => {
    expect(formatSuccessSummary("navigate", { url: "example.com/path" })).toBe(
      "Navigated to example.com/path",
    );
  });

  it("falls back to a bare confirmation when the navigate result carries no URL", () => {
    expect(formatSuccessSummary("navigate", {})).toBe("Navigated");
    expect(formatSuccessSummary("navigate", undefined)).toBe("Navigated");
  });

  it("names the tab a switch or group landed on", () => {
    expect(formatSuccessSummary("switch_tab", { title: "Gmail" })).toBe("Switched to Gmail");
    expect(formatSuccessSummary("group_tab", { title: "Gmail" })).toBe("Grouped Gmail");
  });

  it("names what closed, the way a switch names where it landed", () => {
    expect(formatSuccessSummary("close_tab", { title: "Q3 Invoice" })).toBe("Closed Q3 Invoice");
    expect(formatSuccessSummary("close_tab", {})).toBe("Closed the tab");
  });

  it("says where an opened tab went, like a navigation", () => {
    expect(formatSuccessSummary("open_tab", { url: "https://www.amazon.com/x" })).toBe(
      "Opened amazon.com",
    );
    expect(formatSuccessSummary("open_tab", {})).toBe("Opened a new tab");
  });

  it("reports a find by its matches, and a partial read by its window", () => {
    expect(formatSuccessSummary("find", { matches: ["a", "b"], total: 2 })).toBe("Found 2 matches");
    expect(formatSuccessSummary("find", { matches: ["a"], total: 7 })).toBe("Found 1 of 7 matches");
    expect(formatSuccessSummary("read_page_text", { text: "abc", total: 3 })).toBe(
      "Read 3 characters of page text",
    );
    expect(formatSuccessSummary("read_page_text", { text: "abc", total: 90 })).toBe(
      "Read 3 of 90 characters of page text",
    );
  });
});
