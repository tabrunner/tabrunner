import { i18n } from "@/i18n";
import { truncateTo } from "@/lib/format";
import { stepHint } from "./step-hint";

/** The slice of a persisted step event the note needs — nothing wire-shaped crosses over. */
export interface ProgressStep {
  tool: string;
  summary: string;
  ok?: boolean;
  args?: Record<string, unknown>;
}

/**
 * Kept small enough to survive history replay whole — buildConversationHistory
 * caps entries at 4k chars, and a cut-off note loses the resume instruction.
 */
const MAX_NOTE_LINES = 18;
/** The first steps name where the work started; the last ones name where it stopped. */
const HEAD_LINES = 3;
const MAX_ERROR_CHARS = 300;

function line(step: ProgressStep): string {
  const hint = stepHint(step.tool, step.args);
  return hint ? `${step.summary} · ${hint}` : step.summary;
}

/**
 * The closing summary an interrupted run never got to write — built from the
 * step rows the writer already persisted, NOT from the model: the failures that
 * reach here (a 429, a dead tab) are exactly the ones where asking the model to
 * summarize would fail too. Persisted as an assistant message, so the next
 * run's replayed history carries the progress and the failure, and the model
 * resumes instead of starting over. Returns null when nothing ran — an error
 * before the first step needs no note.
 *
 * Two endings reach here and they close differently. A failure (`errorMessage`)
 * is work to pick back up. A user stop (no message) is the user taking the
 * wheel: their next message decides what happens, so the note offers the
 * history instead of ordering a resume.
 */
export function buildProgressNote(steps: ProgressStep[], errorMessage?: string): string | null {
  if (steps.length === 0) return null;

  // Consecutive repeats collapse — a read/navigate rhythm is one fact, not twelve.
  const compacted: { text: string; count: number }[] = [];
  for (const step of steps) {
    const text = line(step);
    const last = compacted[compacted.length - 1];
    if (last && last.text === text) last.count += 1;
    else compacted.push({ text, count: 1 });
  }

  let lines = compacted.map((c) => (c.count > 1 ? `${c.text} ×${c.count}` : c.text));
  if (lines.length > MAX_NOTE_LINES) {
    const tail = lines.slice(-(MAX_NOTE_LINES - HEAD_LINES - 1));
    lines = [
      ...lines.slice(0, HEAD_LINES),
      i18n.t("progress.omitted", { count: lines.length - HEAD_LINES - tail.length }),
      ...tail,
    ];
  }

  return [
    i18n.t(errorMessage ? "progress.interrupted" : "progress.stopped"),
    ...lines.map((text, i) => `${i + 1}. ${text}`),
    ...(errorMessage
      ? [i18n.t("progress.thenFailed", { message: truncateTo(errorMessage, MAX_ERROR_CHARS) })]
      : []),
    i18n.t(errorMessage ? "progress.resume" : "progress.resumeStopped"),
  ].join("\n");
}
