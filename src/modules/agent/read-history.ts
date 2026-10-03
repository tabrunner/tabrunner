import { getMessages } from "@/modules/conversation";
import type { Message } from "@/modules/conversation/types";
import { stepHint } from "@/modules/conversation/step-hint";
import { i18n } from "@/i18n";
import { truncateTo } from "@/lib/format";
import type { ToolResult } from "./tools";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
/** Per-entry caps — a stored snapshot detail runs to 2k chars, and a hundred of them would swamp the reply. */
const MAX_TEXT_CHARS = 1000;
const MAX_DETAIL_CHARS = 500;
/** Backstop over the whole reply — the model pages instead of swallowing the transcript whole. */
const MAX_LOG_CHARS = 24_000;

/** Run-internal chatter rows are persisted but say nothing about the work done. */
const SKIP_TOOLS = new Set(["retry", "warn"]);

export interface HistoryWindow {
  /** Total readable entries in the transcript — the matching ones when `query` filters. */
  total: number;
  /** Absolute index of the first returned entry. */
  from: number;
  /**
   * Absolute index one past the last returned entry. Pass it as `from` to read
   * forward; pass `from - limit` to keep paging back. Absolute indices are
   * append-stable — the running run keeps adding entries at the tail, and they
   * never shift the numbering of what was already read.
   */
  to: number;
  log: string;
}

export interface WindowOptions {
  from?: number;
  limit?: number;
  includeDetails?: boolean;
  /**
   * Keep only entries containing this text (case-insensitive); paging then runs
   * over the matches. Matches the full record — role, tool, hint, content and
   * detail — not the capped render, so a hit past a line's truncation still lands.
   */
  query?: string;
}

/** What the model can usefully read: the conversation's turns and work rows. Reasoning is display-only noise. */
function readable(m: Message): boolean {
  if (m.role === "user" || m.role === "assistant" || m.role === "error") return true;
  if (m.role === "plan") return true;
  if (m.role === "step") return !!m.tool && !SKIP_TOOLS.has(m.tool);
  return false;
}

function entryLine(m: Message, includeDetails: boolean): string {
  switch (m.role) {
    case "user":
    case "assistant":
      return `${m.role}: ${truncateTo(m.content, MAX_TEXT_CHARS)}`;
    case "error":
      return `error: ${truncateTo(m.content, MAX_DETAIL_CHARS)}`;
    case "plan": {
      const total = m.steps?.length ?? 0;
      const current = m.steps?.[m.current ?? -1];
      return `plan: step ${Math.min((m.current ?? 0) + 1, total)} of ${total}${current ? `: ${current}` : ""}`;
    }
    default: {
      const hint = stepHint(m.tool, m.args);
      const failed = m.ok === false ? " ✗" : "";
      let line = `step ${m.tool}${hint ? ` · ${hint}` : ""}${failed}: ${m.content}`;
      if (includeDetails && m.detail) {
        line += `\n    ↳ ${truncateTo(m.detail, MAX_DETAIL_CHARS)}`;
      }
      return line;
    }
  }
}

/** The haystack a query searches: the full stored record, not the capped line. */
function searchable(m: Message): string {
  return `${m.role} ${m.tool ?? ""} ${stepHint(m.tool, m.args) ?? ""} ${m.content} ${m.detail ?? ""}`.toLowerCase();
}

/**
 * The stored transcript as a numbered, paged text log for the read_history tool.
 * Paging is by absolute index over the readable entries (over the matching ones
 * when `query` filters); omitting `from` returns the newest window, which is the
 * recovery case the tool exists for. The char backstop can cut a window short —
 * `to` then marks where to continue.
 */
export function formatTranscriptWindow(messages: Message[], opts: WindowOptions): HistoryWindow {
  const query = opts.query?.trim().toLowerCase();
  const readableEntries = messages.filter(readable);
  const entries = query
    ? readableEntries.filter((m) => searchable(m).includes(query))
    : readableEntries;
  const total = entries.length;
  if (total === 0) {
    const log = query
      ? i18n.t("errors.historyNoMatches", { query: opts.query?.trim() })
      : i18n.t("errors.historyEmpty");
    return { total: 0, from: 0, to: 0, log };
  }

  const rawLimit = Math.trunc(opts.limit ?? DEFAULT_LIMIT);
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const rawFrom = Math.trunc(opts.from ?? total - limit);
  const from = Math.min(Math.max(rawFrom, 0), total - 1);

  const lines: string[] = [];
  let to = from;
  let size = 0;
  while (to < Math.min(from + limit, total)) {
    const line = `#${to} ${entryLine(entries[to]!, opts.includeDetails === true)}`;
    // Always land at least one entry — a window that returns nothing pages nowhere.
    if (to > from && size + line.length > MAX_LOG_CHARS) break;
    lines.push(line);
    size += line.length;
    to += 1;
  }
  return { total, from, to, log: lines.join("\n") };
}

/** The read_history tool: page through this conversation's stored transcript. */
export async function readStepLog(
  conversationId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const messages = await getMessages(conversationId);
  const opts: WindowOptions = { includeDetails: args.include_details === true };
  if (typeof args.from === "number") opts.from = args.from;
  if (typeof args.limit === "number") opts.limit = args.limit;
  if (typeof args.query === "string") opts.query = args.query;
  return { ok: true, data: formatTranscriptWindow(messages, opts) };
}
