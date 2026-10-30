import type { Message } from "./types";

/**
 * A stored transcript message as plain text — the panel's own view of the run.
 * The one renderer every transcript→model distillation shares: compaction
 * summaries and skill drafts must read the same record the same way.
 */
export function renderTranscriptMessage(m: Message): string {
  switch (m.role) {
    case "user":
      return `USER: ${m.content}`;
    case "assistant":
    case "summary":
      return `AGENT: ${m.content}`;
    case "step":
      return m.tool
        ? `ACTION ${m.tool}${m.ok === false ? " (failed)" : ""}: ${m.content}`
        : `NOTE: ${m.content}`;
    case "error":
      return `ERROR: ${m.content}`;
    // The document itself is images in another store; what a later run needs to
    // know is that it exists and what it covers, so "did you write that up?" has
    // an answer.
    case "artifact":
      return m.artifact
        ? `WALKTHROUGH saved: ${m.artifact.title} (${m.artifact.frames} screens captured)`
        : "";
    case "plan":
      return m.steps?.length ? `PLAN: ${m.steps.join(" | ")}` : "";
    // Reasoning is the one thing never worth carrying: it argues about a page
    // that has since been navigated away from.
    case "reasoning":
      return "";
  }
}

/**
 * Tail-cap a rendered transcript for a distillation call — the newest turns
 * hold the corrections and the outcome, so the tail wins; the oldest are the
 * ones a summary can afford to lose. One budget for every distiller
 * (compaction, skill drafts): 60k chars ≈ 15k tokens, which fits inside any
 * window worth supporting — compaction especially runs precisely because the
 * conversation no longer fits, so handing it the whole thing would fail it
 * for the very reason it was called.
 */
export function capTranscriptTail(body: string, max = 60_000): string {
  if (body.length <= max) return body;
  return `[earlier turns omitted]\n\n${body.slice(-max)}`;
}
