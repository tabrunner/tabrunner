import type { ChatMessage, ChatProvider } from "@/modules/providers/types";
import type { Message } from "@/modules/conversation/types";
import {
  appendMessageTo,
  capTranscriptTail,
  getMessages,
  noteContextFreed,
  renderTranscriptMessage,
} from "@/modules/conversation";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("compact");

/**
 * Compaction - trade a stretch of conversation for a summary of it.
 *
 * In-run compaction is owned by `@providerkit/agents` (`compaction.retryOnContextLimit`)
 * using `COMPACT_SYSTEM` as its summary instructions. This module keeps across-run
 * transcript compaction (`/compact`, the context-error fix button, and the MCP
 * `compact` tool): the transcript keeps every message, the summary is appended,
 * and `buildConversationHistory` replays from it.
 *
 * A browser agent's summary is not a code agent's. What has to survive is what
 * was found on which page, what was already done to the world (a form
 * submitted, a message sent - actions that must not be repeated), and what is
 * left. Reasoning about the DOM is worthless a page later; a confirmation
 * number is worth the whole summary.
 */
export const COMPACT_SYSTEM = `You are compacting the record of a browser-automation session so the agent can keep working with a smaller context.

Write a dense factual summary under these headings, omitting any that have no content:

1. Task: what the user asked for, in their terms, including every correction or change of mind.
2. Findings: concrete data gathered, including names, prices, dates, confirmation numbers, quotes and URLs. Reproduce exact values; this is the only place they survive.
3. Pages: which sites and pages were visited and what each was for.
4. Actions taken: everything already done, including forms submitted, messages sent, items purchased and settings changed. Be exhaustive and unambiguous: whatever is missing here may be done a second time.
5. Obstacles: what failed, what was blocked (logins, captchas, missing permissions), and what was tried.
6. Remaining: what is still outstanding for the task to be complete.

Rules:
- Facts only. No commentary, no restating these instructions, no describing the summary itself.
- Preserve exact values verbatim. Never round, never paraphrase an identifier.
- Omit reasoning about page structure, element ids and scrolling. The agent re-reads the page.
- Plain text under the numbered headings. No preamble, no sign-off.`;

/** One provider call, no tools, text collected. */
async function summarize(
  provider: ChatProvider,
  body: string,
  signal: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: COMPACT_SYSTEM },
    { role: "user", content: capTranscriptTail(body) },
  ];
  let text = "";
  for await (const delta of provider.stream(messages, [], signal)) {
    if (delta.type === "text") text += delta.text;
  }
  const summary = text.trim();
  if (!summary) throw new Error(i18n.t("errors.compactEmpty"));
  return summary;
}

/**
 * Summarize a stretch of transcript. The caller decides what to do with it —
 * the transcript writer appends it as a `summary` message, which is what makes
 * `buildConversationHistory` replay from there instead of from a budget-trimmed
 * slice of the raw messages.
 */
export async function summarizeTranscript(
  provider: ChatProvider,
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  const body = messages.map(renderTranscriptMessage).filter(Boolean).join("\n\n");
  if (!body.trim()) throw new Error(i18n.t("errors.compactEmpty"));
  return summarize(provider, body, signal);
}

/** Below this there is nothing a summary would buy — say so instead of calling the model. */
const MIN_COMPACT_MESSAGES = 4;

export interface CompactionResult {
  /** How many transcript messages the summary now stands in for. */
  messages: number;
  /** Estimated replay tokens before and after — the receipt the fold shows. */
  before: number;
  after: number;
}

/**
 * Compact a stored conversation: summarize everything since the last compaction
 * and append the summary. Nothing is deleted — `buildConversationHistory`
 * replays from the summary, while the panel keeps every message it always had.
 *
 * The fold runs to the very tail, recent exchange included. Keeping it raw
 * would put the summary after it, and replay starts at the summary — so a
 * "kept" tail would reach neither the summarizer nor the model. The summary
 * covers it instead, and the `read_history` tool can still page the raw
 * transcript when a follow-up needs an exact wording.
 *
 * Returns null when the conversation is too short to be worth a model call.
 *
 * ponytail: the summary is appended wherever the tail is when the model answers,
 * not where it was when we read. Both callers refuse to compact a conversation
 * with a run in flight, so the only way to interleave is a user sending a task
 * during the few seconds a summarizer takes — and the next compaction folds from
 * this summary to the tail, so the stranded turn is swept up rather than lost
 * for good. Ceiling: that turn is invisible to replay until then. The upgrade is
 * an insert-at-index transcript write, so the summary lands where it was cut.
 */
export async function compactConversation(
  provider: ChatProvider,
  conversationId: string,
  signal: AbortSignal,
): Promise<CompactionResult | null> {
  const all = await getMessages(conversationId);
  // Everything since the last compaction — the previous summary included, so
  // this one supersedes it rather than forgetting what it held.
  const lastSummary = all.map((m) => m.role).lastIndexOf("summary");
  const from = lastSummary === -1 ? 0 : lastSummary;
  const foldable = all.slice(from);
  if (foldable.length < MIN_COMPACT_MESSAGES) return null;

  const before = transcriptTokens(foldable);
  const summary = await summarizeTranscript(provider, foldable, signal);
  const compacted: CompactionResult = {
    messages: foldable.length,
    before,
    after: estimateTokens(summary),
  };
  await appendMessageTo(conversationId, {
    id: crypto.randomUUID(),
    role: "summary",
    content: summary,
    timestamp: Date.now(),
    compacted,
  });
  // The gauge's between-runs fallback describes a request that will never be
  // sent again — move it by what the fold freed. After the append, or the index
  // rewrite that append performs would put the stale number straight back.
  await noteContextFreed(conversationId, before - compacted.after);
  log.info(`compacted ${compacted.messages} messages: ${before} → ${compacted.after} tokens`);
  return compacted;
}

/** Rough token count for a rendered body — 4 chars/token, the usual approximation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** What a transcript would cost to replay, for the compaction receipt's before/after. */
export function transcriptTokens(messages: Message[]): number {
  return estimateTokens(messages.map(renderTranscriptMessage).filter(Boolean).join("\n\n"));
}
