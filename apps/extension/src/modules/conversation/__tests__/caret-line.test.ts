import { describe, it, expect, vi, afterEach } from "vitest";
import { caretVisualLine } from "../ui/caret-line";

/**
 * jsdom has no layout, so the mirror gets a fake one: a monospace grid of COLS
 * visible columns that hard-wraps, where "\n" ends a row and the zero-width
 * space takes no column. Wrapping has to be in the fake — the bug it guards
 * lived entirely there: with a marker that held nothing, the caret at the first
 * character of a WRAPPED second row measured as row 0, so ↑ recalled a sent
 * message instead of moving the caret up a row. (Hard newlines always
 * measured right, which is why it shipped.) The arithmetic contract rides
 * along: the composer HAS vertical padding (py-2), the mirror does NOT, and the
 * measurements must not subtract what was never added.
 */
const LINE_H = 20;
const COLS = 10;

/** Row of every character in the mirror's content, and how many rows in all. */
function layout(text: string): { rowOf: number[]; rows: number } {
  const rowOf: number[] = [];
  let row = 0;
  let col = 0;
  for (const ch of text) {
    if (ch !== "\n" && ch !== "​" && col === COLS) {
      row++;
      col = 0;
    }
    rowOf.push(row);
    if (ch === "\n") {
      row++;
      col = 0;
    } else if (ch !== "​") col++;
  }
  return { rowOf, rows: row + 1 };
}

function fakeTextarea(value: string, caret: number): HTMLTextAreaElement {
  // Layout stub — only the three reads caretVisualLine makes.
  return { value, selectionStart: caret, clientWidth: 320 } as HTMLTextAreaElement;
}

function stubLayout(computedLineHeight = `${LINE_H}px`): void {
  // The mirror as the DOM has it: a text node plus the appended marker span.
  // Setting textContent replaces the children, marker included.
  let mirror = { text: "", marker: null as { textContent: string } | null };
  const content = () => mirror.text + (mirror.marker?.textContent ?? "");
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "div") {
      const div = {
        style: {} as Record<string, string>,
        set textContent(v: string) {
          mirror.text = v;
          mirror.marker = null;
        },
        appendChild(node: { textContent: string }) {
          mirror.marker = node;
        },
        remove: () => {},
        get clientHeight() {
          return LINE_H * layout(content()).rows;
        },
      };
      mirror = { text: "", marker: null };
      return div as unknown as HTMLElement;
    }
    // The caret marker: its top is the row its first character lands on.
    const span = {
      textContent: "",
      get offsetTop() {
        return (layout(content()).rowOf[mirror.text.length] ?? 0) * LINE_H;
      },
    };
    return span as unknown as HTMLElement;
  });
  vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: "12px",
    paddingRight: "12px",
    paddingTop: "8px",
    paddingBottom: "8px",
    lineHeight: computedLineHeight,
  } as unknown as CSSStyleDeclaration);
}

afterEach(() => vi.restoreAllMocks());

describe("caretVisualLine", () => {
  it("counts a one-line draft as one line — the composer's padding is not the mirror's", () => {
    stubLayout();
    expect(caretVisualLine(fakeTextarea("one", 3))).toEqual({ line: 0, lines: 1 });
  });

  it("places the caret on the second line of two", () => {
    stubLayout();
    expect(caretVisualLine(fakeTextarea("a\nbb", 4))).toEqual({ line: 1, lines: 2 });
  });

  it("keeps a trailing newline's empty line alive via the marker", () => {
    stubLayout();
    expect(caretVisualLine(fakeTextarea("a\n", 2))).toEqual({ line: 1, lines: 2 });
  });

  it("measures the line-height when the computed style says 'normal'", () => {
    stubLayout("normal");
    expect(caretVisualLine(fakeTextarea("a\nbb", 4))).toEqual({ line: 1, lines: 2 });
  });

  it("puts the caret on the wrapped row it starts, not the row above it", () => {
    stubLayout();
    // COLS visible characters fill row 0, so the caret at COLS opens row 1 —
    // ↑ there must move the caret up, never recall.
    expect(caretVisualLine(fakeTextarea("0123456789abc", 10))).toEqual({ line: 1, lines: 2 });
    expect(caretVisualLine(fakeTextarea("0123456789abc", 9))).toEqual({ line: 0, lines: 2 });
  });

  it("still reaches the last row of a wrapped draft, so ↓ can recall", () => {
    stubLayout();
    expect(caretVisualLine(fakeTextarea("0123456789abc", 13))).toEqual({ line: 1, lines: 2 });
  });
});
