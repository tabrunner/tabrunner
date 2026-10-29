/**
 * Collapsed-text paste, mirroring the image flow's token-in-text trick: a big
 * multi-line paste becomes a short token in the input ([Pasted 5 lines]) while
 * the full text is held here and spliced back in on send. Unlike images the
 * token never reaches the wire — it expands away in submit().
 */

/** Collapse pastes with more than this many lines into a token. */
const PASTE_LINE_THRESHOLD = 4;

/** A collapsed paste — its token in the input and the full text it stands for. */
export interface PastedText {
  token: string;
  content: string;
}

export function linesOf(text: string): number {
  return text.split("\n").length;
}

/** A big multi-line paste gets collapsed; short ones paste inline like normal. */
export function shouldCollapse(text: string): boolean {
  return linesOf(text) > PASTE_LINE_THRESHOLD;
}

/**
 * The next free token for a collapse. `label` is the translated "Pasted 5
 * lines" wording; a label already in use gets a duplicate number, so two
 * same-size pastes stay distinct: [Pasted 5 lines] then [Pasted 5 lines (2)].
 * The "(N)]" suffix keeps tokens mutually non-suffix, so a shorter token never
 * matches inside a collided one — backspace and expand both rely on that.
 */
export function nextToken(used: Set<string>, label: string): string {
  let n = 1;
  let token = `[${label}]`;
  while (used.has(token)) {
    n += 1;
    token = `[${label} (${n})]`;
  }
  return token;
}

/** Insert a token at the caret, replacing any selection. */
export function insertToken(
  text: string,
  caretStart: number,
  caretEnd: number,
  token: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, caretStart) + token + text.slice(caretEnd),
    caret: caretStart + token.length,
  };
}

/**
 * Replace every collapse token with its full content before sending. Oldest
 * first: an already-expanded block is never rescanned for a later block's token
 * (paste order == array order, since pastes append).
 */
export function expandText(text: string, pasted: PastedText[]): string {
  return pasted.reduce((acc, p) => acc.split(p.token).join(p.content), text);
}
