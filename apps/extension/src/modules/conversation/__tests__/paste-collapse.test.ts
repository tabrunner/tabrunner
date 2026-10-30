import { describe, it, expect } from "vitest";
import { expandText, insertToken, nextToken, shouldCollapse } from "../ui/paste-collapse";

const lbl = (n: number) => `Pasted ${n} lines`;

describe("shouldCollapse", () => {
  it("collapses pastes past the line threshold, keeps short ones inline", () => {
    expect(shouldCollapse("one line")).toBe(false);
    expect(shouldCollapse("a\nb\nc\nd")).toBe(false); // 4 lines
    expect(shouldCollapse("a\nb\nc\nd\ne")).toBe(true); // 5 lines
  });
});

describe("nextToken", () => {
  it("is clean the first time, bumps on reuse so two same-size pastes stay distinct", () => {
    expect(nextToken(new Set(), lbl(5))).toBe("[Pasted 5 lines]");
    const used = new Set(["[Pasted 5 lines]"]);
    expect(nextToken(used, lbl(5))).toBe("[Pasted 5 lines (2)]");
  });

  it("collided tokens are mutually non-suffix — backspace and expand both rely on it", () => {
    const first = nextToken(new Set(), lbl(5));
    const second = nextToken(new Set([first]), lbl(5));
    expect(second.endsWith(first)).toBe(false);
    expect(first.endsWith(second)).toBe(false);
  });
});

describe("insertToken", () => {
  it("replaces the selection and reports the caret after the token", () => {
    const r = insertToken("go there and do it", 12, 12, "[Pasted 5 lines]");
    expect(r.text).toBe("go there and[Pasted 5 lines] do it");
    expect(r.caret).toBe(28);
    const over = insertToken("abc", 0, 3, "[Pasted 5 lines]");
    expect(over.text).toBe("[Pasted 5 lines]");
    expect(over.caret).toBe(16);
  });
});

describe("expandText", () => {
  it("splices the stored content back in place of every token", () => {
    const pasted = [{ token: "[Pasted 5 lines]", content: "a\nb\nc\nd\ne" }];
    expect(expandText("now:\n[Pasted 5 lines]\nthanks", pasted)).toBe(
      "now:\na\nb\nc\nd\ne\nthanks",
    );
  });

  it("oldest-first: a token inside an earlier block's content is not re-expanded", () => {
    const pasted = [
      { token: "[Pasted 5 lines]", content: "first [Pasted 5 lines]" },
      { token: "[Pasted 5 lines (2)]", content: "second" },
    ];
    // Both pastes had 5 lines, so the second got the (2) suffix. The literal
    // "[Pasted 5 lines]" inside the FIRST block's own content (copied along
    // with it) must survive expansion instead of being treated as a token.
    expect(expandText("[Pasted 5 lines] [Pasted 5 lines (2)]", pasted)).toBe(
      "first [Pasted 5 lines] second",
    );
  });

  it("a shorter token never matches inside a collided token", () => {
    const pasted = [
      { token: "[Pasted 5 lines]", content: "one" },
      { token: "[Pasted 5 lines (2)]", content: "two" },
    ];
    expect(expandText("[Pasted 5 lines (2)]", pasted)).toBe("two");
  });
});
