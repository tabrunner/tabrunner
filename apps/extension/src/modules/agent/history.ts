import type { Message } from "@/modules/conversation/types";
import type { ChatMessage } from "@/modules/providers/types";
import { truncate } from "@/lib/logger";
import { DEFAULT_CONTEXT_WINDOW } from "@/modules/providers/context-window";

/**
 * Per-entry cap — one enormous message must not crowd out the conversation
 * around it. Generous on purpose: an assistant answer often IS the payload the
 * next message refers to ("search those names"), and a cap that cuts the list
 * in half leaves the model working from half a list.
 */
const MAX_ENTRY = 4_000;

/**
 * Share of the model's window the replayed conversation may spend. The rest
 * belongs to the run itself — the system prompt, the tool definitions, the page
 * snapshot every turn carries, and the results it gathers.
 *
 * This replaced a flat 24k characters, which was the same ~6k tokens whether
 * the model held 32k or a million. On the 200k default this is ~80k characters,
 * roughly 20k tokens.
 */
const HISTORY_SHARE = 0.1;
const CHARS_PER_TOKEN = 4;

/** Never less than this, whatever the window: a couple of exchanges is the floor of useful. */
const MIN_HISTORY_CHARS = 24_000;

export function historyBudgetChars(contextWindow = DEFAULT_CONTEXT_WINDOW): number {
  return Math.max(MIN_HISTORY_CHARS, Math.floor(contextWindow * HISTORY_SHARE * CHARS_PER_TOKEN));
}

const IMAGE_TOKEN = /\s?\[Image #\d+\]/g;

/**
 * The conversation as alternating wire turns: every user message (the task,
 * the corrections, the answers) and the assistant's replies in its own words.
 * Steps, plans and reasoning stay out — what happened lives in the assistant's
 * summaries (an interrupted run gets a deterministic one — progress-note.ts —
 * so the summary exists even when the model never wrote one), and the fresh
 * run re-reads the page itself. Both adapters
 * serialize these turns with the same code path as the run's own.
 *
 * Replay starts at the newest `summary` message when the conversation has been
 * compacted: that message IS everything above it, so replaying both would send
 * the same history twice. Everything above stays in storage and stays on
 * screen — compaction is a fact about what the model reads, not about what the
 * user keeps.
 */
export function buildConversationHistory(
  transcript: Message[],
  contextWindow?: number,
): ChatMessage[] {
  // The last user message is the run about to start — the loop builds its task
  // message itself, so history ends right before it.
  const lastUser = transcript.map((m) => m.role).lastIndexOf("user");
  if (lastUser === -1) return [];
  const compactedAt = transcript.map((m) => m.role).lastIndexOf("summary");
  // A summary written after the last user message belongs to a run that has not
  // been replied to yet — replaying from it would drop the message it followed.
  const from = compactedAt !== -1 && compactedAt < lastUser ? compactedAt : 0;
  const past = transcript.slice(from, lastUser);

  const entries: ChatMessage[] = [];
  for (const m of past) {
    // ask_user steps join as assistant turns — without them the user's answer
    // would replay as a reply to a question the model never sees. A summary is
    // the agent's own account of the work, so it replays in the agent's voice.
    const role =
      m.role === "summary" || (m.role === "step" && m.tool === "ask_user") ? "assistant" : m.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = truncate(m.content, MAX_ENTRY).replace(IMAGE_TOKEN, "").trim();
    if (content) entries.push({ role, content });
  }

  // Spend the budget newest-first, then keep the original task on top: the
  // model needs what was just said, and why it was ever asked.
  const first = entries[0];
  let budget = historyBudgetChars(contextWindow) - (first?.content.length ?? 0);
  let keptFrom = entries.length;
  while (keptFrom > 1 && budget - entries[keptFrom - 1]!.content.length >= 0) {
    keptFrom -= 1;
    budget -= entries[keptFrom]!.content.length;
  }
  const kept = first ? [first, ...entries.slice(Math.max(keptFrom, 1))] : [];

  // The wire requires alternating roles — merge runs of the same role (several
  // assistant bubbles per run, back-to-back user notes, or the trim seam).
  const turns: ChatMessage[] = [];
  for (const entry of kept) {
    const prev = turns[turns.length - 1];
    if (prev && prev.role === entry.role) prev.content += `\n\n${entry.content}`;
    else turns.push({ ...entry });
  }
  return turns;
}
