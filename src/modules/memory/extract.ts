import {
  ProviderError,
  type ChatMessage,
  type ResolvedProviderConfig,
} from "@/modules/providers/types";
import { createProvider } from "@/modules/providers";
import { createLogger, truncate } from "@/lib/logger";
import {
  DURABLE_FACT_RULES,
  filterDocForHost,
  getDoc,
  memoryEnabled,
  remember,
  type ScopedFact,
} from "./documents";
import { normalizeHost, scopeHostOf } from "@/lib/host";

const log = createLogger("memory");

/** Hard ceiling per run — a run that teaches more than this is one-off noise. */
const MAX_FACTS_PER_RUN = 3;

/**
 * One message's text ceiling on the extraction wire. Snapshots dominate a run's
 * transcript and the distillation only needs the gist of each step — full pages
 * would make the call slow enough to outlive the service worker hosting it.
 */
const MAX_MESSAGE_CHARS = 4_000;

/** A hung provider must not pin the worker (and its keepalive alarm) forever. */
const EXTRACTION_TIMEOUT_MS = 90_000;

/**
 * The extraction turn's system prompt. Mirrors claude-code-original's
 * `extractMemories` prompt in the minimum TabRunner needs: no taxonomy, one flat
 * memory list, a strict "what not to save". The current MEMORY.md rides along so
 * the model doesn't re-save what it already knows (`remember()` dedups anyway).
 *
 * The "most runs teach nothing" line is load-bearing. This turn is handed a
 * transcript and asked for a list, and a model asked for a list produces one —
 * the pull toward filling the quota with whatever the run happened to read is
 * exactly how a page's numbers end up in memory. It needs telling that empty is
 * the expected answer.
 */
export function buildExtractionSystemPrompt(memory: string, hint: string | null = null): string {
  return `Below is the transcript of a browser-automation run that just completed. Review it and identify durable facts worth remembering for future runs.

${DURABLE_FACT_RULES}

Most runs teach nothing durable. That is the normal outcome and "none" is the right answer — a run that only looked something up almost always ends there. Never name more than 3 facts.

Reply with only the facts, one per line, each starting with "- ". When a fact is about one specific site, tag it with the site's domain in brackets: "- [acme.com] Login is the email link, not SSO." A line with no tag is a global fact about the user.${hint ? ` This run worked mainly on ${hint} — facts learned there should carry its tag.` : ""} If nothing is durable, reply with exactly: none

Current memory:
${memory || "(empty)"}`;
}

function capText(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

/**
 * The transcript the extraction call sees: the run's wire messages minus the
 * system prompt, with everything the extraction turn cannot use stripped —
 * screenshots (`data:` URLs — huge) and reasoning. Tool calls and results stay,
 * so the model can tell what the run actually did.
 *
 * Three wire-validity rules keep the replay from being rejected outright:
 *
 * - A run's last turn ends on `done`/`ask_user`, whose result the loop never
 *   records — replayed verbatim, that unmatched tool call 400s the extraction
 *   request on every strict provider (Anthropic, OpenAI alike). Only calls
 *   that got a result ride along.
 * - The wire closes on a user turn asking for the list. A run ends on the
 *   assistant's own words (the summary riding its `done` call survives the
 *   filter above), and a trailing assistant message is an assistant-prefill
 *   400 on Anthropic. Closing on the ask also restates the output contract
 *   where the model's attention is freshest.
 * - Oversized texts are capped, so a long run's transcript stays a quick,
 *   cheap call instead of a full page-by-page replay.
 */
export function buildExtractionMessages(
  transcript: ChatMessage[],
  memory: string,
  hint: string | null = null,
): ChatMessage[] {
  const answered = new Set(transcript.flatMap((m) => (m.toolResults ?? []).map((r) => r.id)));
  const messages: ChatMessage[] = [
    { role: "system", content: buildExtractionSystemPrompt(memory, hint) },
  ];
  for (const m of transcript) {
    if (m.role === "system") continue;
    const toolCalls = m.toolCalls?.filter((c) => answered.has(c.id));
    const content = capText(m.content);
    // An assistant turn that was only a done/ask_user call is empty once its
    // call is filtered out — and an empty message is its own wire error.
    if (m.role === "assistant" && !content && !toolCalls?.length) continue;
    messages.push({
      role: m.role,
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      toolResults: m.toolResults?.map((r) => ({ id: r.id, content: capText(r.content) })),
    });
  }
  // The closing ask — see the trailing-assistant rule above. Merges into a
  // final tool_results turn on the Anthropic wire (mergeConsecutiveUsers).
  messages.push({
    role: "user",
    content: `Which durable facts from this run are worth remembering? One "- " line each, or exactly: none`,
  });
  return messages;
}

/**
 * Parse the extraction reply. Only explicit list lines count — a model that
 * answers in prose saves nothing, which is safer than remembering a stray
 * sentence. "none" lines are skipped; stray preamble lines are skipped. A
 * leading "[host]" tag scopes the fact to that site; a tag that isn't a host
 * is stripped and the fact saved global — junk must not become fact text.
 */
export function parseExtractedFacts(reply: string): ScopedFact[] {
  const facts: ScopedFact[] = [];
  for (const line of reply.split("\n")) {
    const trimmed = line.trim();
    if (/^none\.?$/i.test(trimmed)) continue;
    if (!/^[-*]\s+/.test(trimmed)) continue;
    let fact = trimmed.replace(/^[-*]\s+/, "").trim();
    let site: string | undefined;
    const tagged = /^\[([^\]]+)\]\s+(.+)$/.exec(fact);
    if (tagged?.[1] && tagged[2]) {
      site = normalizeHost(tagged[1]) ?? undefined;
      fact = tagged[2].trim();
    }
    if (fact) facts.push({ text: fact, ...(site ? { site } : {}) });
    if (facts.length >= MAX_FACTS_PER_RUN) break;
  }
  return facts;
}

/**
 * One best-effort extraction call at run end: replay the run's text-only
 * transcript to the model, parse the durable facts it names, and remember each.
 * Never throws — memory is a nice-to-have, a failed call must not surface. It
 * IS logged at warn, though: a silently-dying extraction once shipped as
 * "memory never works", invisible at debug level.
 */
export async function extractAndRemember(
  config: ResolvedProviderConfig,
  transcript: ChatMessage[],
  signal: AbortSignal,
  finalUrl?: string,
): Promise<void> {
  try {
    // Same gate as buildToolDefs — memory off means nothing is loaded or written.
    if (!(await memoryEnabled.get())) return;
    if (signal.aborted) return;

    // The "current memory" the model must not re-save is the same slice a
    // future run on this site will load — other sites' facts stay off the wire
    // (remember()'s per-scope dedupe still catches any cross-site restatement).
    const hint = scopeHostOf(finalUrl);
    const memory = filterDocForHost(await getDoc("MEMORY.md"), hint);
    const messages = buildExtractionMessages(transcript, memory, hint);
    // The extraction turn needs no thinking tokens and sees no images.
    const extraction = createProvider({
      ...config,
      reasoningEffort: undefined,
      supportsImages: false,
    });

    // The run's signal is not expected to fire (extraction is skipped on stop),
    // but the timeout is real: a hung stream must release the worker.
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)]);
    let reply = "";
    for await (const delta of extraction.stream(messages, [], bounded)) {
      if (delta.type === "text") reply += delta.text;
    }
    // "none" is the expected answer; nothing at all (a reply that only thought) is not.
    if (!reply.trim()) log.warn("extraction came back empty — nothing remembered");

    for (const fact of parseExtractedFacts(reply)) {
      const stored = await remember(fact.text, fact.site);
      if (stored)
        log.info("remembered:", stored.site ? `[${stored.site}]` : "", truncate(stored.text, 100));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const kind = e instanceof ProviderError && e.kind ? ` (${e.kind})` : "";
    if (signal.aborted) log.debug("extraction aborted:", message);
    else log.warn(`extraction failed${kind}:`, message);
  }
}
