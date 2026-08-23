import { createLogger } from "@/lib/logger";
import { truncateTo } from "@/lib/format";
import { createProvider } from "@/modules/providers/factory";
import type { ChatMessage, ResolvedProviderConfig } from "@/modules/providers/types";
import {
  conversationTitle,
  isPartialTitle,
  listConversations,
  retitleIfDerived,
} from "@/modules/conversation/conversations";

const log = createLogger("title");

const TITLE_SYSTEM = `You name browser-automation conversations for a history list.

Given the task the user sent, write a short title that names what the run was for — the thing it did or the page it worked, not the literal opening words.

Rules:
- 3 to 7 words. No quotes, no trailing period, no "Task:" or "Title:" prefix.
- Match the task's language.
- Be specific over generic: "Book a table at Rossi's" beats "Help with reservations".
- Answer with the title alone, nothing else.`;

/** A hung stream must not pin the worker — same ceiling as memory extraction. */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * Re-titles a conversation the first-line heuristic titled badly. Called after
 * every run with that run's task; the stored title decides the rest, and it
 * answers two questions at once:
 *
 * - Is this the task that NAMED the thread? Only the opening message ever sets
 *   a title (`appendTo` fills a blank one and never overwrites), so a stored
 *   title equal to what this task derives is that message and no other. Asking
 *   storage is what keeps this correct no matter when the caller's transcript
 *   read happened — a panel or bridge run stores its user message before the
 *   run starts, so counting the transcript's user turns can never tell an
 *   opening task from a follow-up.
 * - Has the user named it themselves? A rename breaks that same equality, so
 *   the comparison at write time (not a flag at read time) protects it, even
 *   from a rename that raced this call.
 *
 * One cheap call, no thinking, shaped exactly like memory extraction. Never
 * fires on a title that already says the task — `isPartialTitle` is false when
 * the first line was the whole message and fit, which is most conversations.
 */
export async function maybeAutoTitle(
  conversationId: string,
  task: string,
  config: ResolvedProviderConfig,
  signal: AbortSignal,
): Promise<void> {
  try {
    // Nothing to improve when the first line already IS the task.
    if (!isPartialTitle(task)) return;
    if (signal.aborted) return;

    const derived = conversationTitle(task);
    // Only retitle a conversation still wearing what this message derived. If a
    // later task re-derived the title, or a rename replaced it, hands off.
    const row = (await listConversations()).find((c) => c.id === conversationId);
    if (!row || row.title !== derived) return;

    const titler = createProvider({
      ...config,
      reasoningEffort: undefined,
      supportsImages: false,
    });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(TITLE_TIMEOUT_MS)]);
    const messages: ChatMessage[] = [
      { role: "system", content: TITLE_SYSTEM },
      { role: "user", content: truncateTo(task, 2_000) },
    ];
    let title = "";
    for await (const delta of titler.stream(messages, [], bounded)) {
      if (delta.type === "text") title += delta.text;
    }
    if (!title.trim()) return;

    await retitleIfDerived(conversationId, derived, title);
    log.info("auto-titled:", truncateTo(title.trim(), 60));
  } catch (e) {
    // A failed title is a null event — the heuristic title stays, and nothing
    // about the run or the conversation should notice. Log and move on.
    log.debug("auto-title skipped:", e instanceof Error ? e.message : String(e));
  }
}
