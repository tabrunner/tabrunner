import { describe, it, expect } from "vitest";
import { closingSummary } from "../ui/store";

describe("closingSummary", () => {
  it("shows the summary when the run streamed no prose", () => {
    expect(closingSummary(false, undefined, "Found 3 flights")).toBe("Found 3 flights");
  });

  it("still shows it after mid-run prose — a one-liner must not swallow the answer", () => {
    expect(closingSummary(true, "Searching now", "Found 3 flights")).toBe("Found 3 flights");
  });

  it("drops a verbatim repeat of the streamed prose, blind to case, whitespace, trailing punctuation", () => {
    expect(closingSummary(true, "Found 3 flights.", "found  3 flights")).toBeNull();
    expect(closingSummary(true, "Found 3 flights! ", "found 3 flights")).toBeNull();
  });

  it("trims the summary and drops it when blank or missing", () => {
    expect(closingSummary(false, undefined, "  Found 3 flights  ")).toBe("Found 3 flights");
    expect(closingSummary(false, undefined, undefined)).toBeNull();
    expect(closingSummary(false, undefined, "   ")).toBeNull();
  });
});
