/**
 * Where the caret sits in a textarea, in VISUAL lines — soft wraps count.
 * History recall's edge rule needs them: a long paragraph wraps into many rows
 * in the narrow composer, and ↑ on a wrapped row must move the caret up one
 * row, not recall a sent message. Logical lines (\n) can't see wraps, so we
 * measure instead: a mirror div with the same typography and content width
 * holds the text up to the caret, then a marker span holding everything after
 * it, and the marker's offset names the line. One attach, a few layout reads,
 * straight back out.
 */
const COPY_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "overflowWrap",
] as const;

export function caretVisualLine(el: HTMLTextAreaElement): { line: number; lines: number } {
  const cs = getComputedStyle(el);
  const mirror = document.createElement("div");
  const style = mirror.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.whiteSpace = "pre-wrap";
  style.boxSizing = "content-box";
  // Content width, not element width: clientWidth includes the padding.
  style.width = `${el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
  for (const p of COPY_PROPS) style[p] = cs[p];
  document.body.appendChild(mirror);
  try {
    // The mirror carries no padding, so its offsets and height measure pure
    // content lines. The computed style usually states the line-height; only
    // "normal" names no number and needs measuring (one line vs two).
    let lineH = parseFloat(cs.lineHeight);
    if (Number.isNaN(lineH)) {
      mirror.textContent = "x";
      const one = mirror.clientHeight;
      mirror.textContent = "x\nx";
      lineH = mirror.clientHeight - one;
    }

    // The marker carries the text AFTER the caret, so it starts on the row the
    // caret sits on. A marker holding nothing would instead sit at the end of
    // the row it fills — at a soft wrap the caret then read as row 0, and ↑
    // from the first character of a wrapped second row recalled history
    // instead of moving up. Its trailing zero-width space keeps an empty
    // wrapped/trailing line alive, and leaves the mirror holding the whole
    // value, so one layout gives both the row and the row count.
    const caret = el.selectionStart;
    mirror.textContent = el.value.slice(0, caret);
    const marker = document.createElement("span");
    marker.textContent = `${el.value.slice(caret)}\u200B`;
    mirror.appendChild(marker);
    const line = Math.round(marker.offsetTop / lineH);
    const lines = Math.round(mirror.clientHeight / lineH);
    return { line: Math.min(line, lines - 1), lines };
  } finally {
    mirror.remove();
  }
}
