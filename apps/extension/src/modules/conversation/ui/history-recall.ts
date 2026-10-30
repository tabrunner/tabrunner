import type { Message } from "../types";

/**
 * What you sent in this conversation, newest first — the ↑ history.
 * Consecutive repeats collapse, as in a shell: pressing ↑ twice should move you
 * back two messages, not show you the same one again.
 */
export function sentMessages(messages: Message[]): string[] {
  const sent: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || !m.content.trim()) continue;
    if (sent[sent.length - 1] !== m.content) sent.push(m.content);
  }
  return sent;
}

/** Where the composer is in the ↑ history. */
export interface Browse {
  /** Position in the history; `null` means "editing your own draft". */
  index: number | null;
  /** What the composer shows. */
  text: string;
  /** The unsent draft the browse started from — where ↓ past the newest lands. */
  draft: string;
}

/**
 * One step through the sent history. Returns null when the arrow is not a
 * recall — the caret should move instead.
 *
 * - `atEdge` is the caller's line check: ↑ recalls only from the caret's first
 *   line and ↓ only from its last, so arrows still navigate a multi-line draft.
 *   The composer measures VISUAL lines (caret-line.ts) — a soft wrap is a row
 *   the user sees, even if no break was typed.
 * - A filled composer browses too: your draft is stashed on the way out and
 *   handed back when ↓ walks past the newest entry, so nothing is ever lost.
 * - Browsing holds only while the composer still shows the recalled entry; an
 *   edit, a send, or a conversation switch makes it your draft again, and the
 *   next ↑ starts over from the newest.
 * - ↑ at the oldest entry holds rather than wrapping — a wrap silently loses
 *   your place in a long history.
 */
export function recallStep(
  key: "ArrowUp" | "ArrowDown",
  history: string[],
  state: { index: number | null; text: string; atEdge: boolean; draft: string },
): Browse | null {
  if (!state.atEdge) return null;
  const { text } = state;
  const at = state.index !== null && history[state.index] === text ? state.index : null;
  const draft = at === null ? text : state.draft;
  const next = (at ?? -1) + (key === "ArrowUp" ? 1 : -1);
  // Below the newest is your own draft — and below that, nothing to recall.
  if (next < 0) return at === null ? null : { index: null, text: draft, draft };
  const recalled = history[next];
  return recalled === undefined ? null : { index: next, text: recalled, draft };
}
