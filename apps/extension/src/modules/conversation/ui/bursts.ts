import type { Message } from "../types";

/**
 * With reasoning hidden, a transcript alternates heavy "Thought for 2s" chips
 * with quiet tool rows — one row per action, all noise. A burst folds each
 * maximal run of thoughts and steps into a single quiet line ("Thinking,
 * Clicking e25, Typing 200 and 5 more · 2m 10s") that expands back to the
 * rows. Any run with 2+ items and at least one step folds — thinking is not
 * required. What stays flat: a lone chip or a single tool row (already quiet),
 * and thought-only runs (a burst's summary is built from its steps).
 */
export interface Burst {
  kind: "burst";
  id: string;
  /** The run in original order — steps and the thoughts between them. */
  items: Message[];
  steps: Message[];
  /** Epoch ms when the run began. A thought's timestamp marks its END, so a leading thought walks back its elapsed. */
  startedAt: number;
  /** Epoch ms when the run ended — absent while it is the tail of the transcript. */
  endedAt?: number;
  /** Run in flight and this burst is the transcript's tail — open the whole
   *  run (thinking phases included), settling closed only when it ends. */
  live: boolean;
}

export type RenderItem = { kind: "message"; msg: Message } | Burst;

/** An ask_user card is a pause for the user, not an action — it never folds into a burst.
 *  Neither does a tool-less step: those are local notes (slash-command results), and
 *  folding one in would count it as an "other action" it isn't. */
function burstable(m: Message): boolean {
  return (
    m.role === "reasoning" || (m.role === "step" && m.tool !== undefined && m.tool !== "ask_user")
  );
}

export function groupBursts(messages: Message[], running = false): RenderItem[] {
  const out: RenderItem[] = [];
  let run: Message[] = [];

  const flush = (endedAt?: number) => {
    const first = run[0];
    if (!first) return;
    const steps = run.filter((m) => m.role === "step");
    if (steps.length > 0 && run.length > 1) {
      out.push({
        kind: "burst",
        id: first.id,
        items: run,
        steps,
        startedAt: first.timestamp - (first.role === "reasoning" ? (first.elapsed ?? 0) : 0),
        endedAt,
        // Keyed to the run, not to a step's live flag: a burst tied to an
        // in-flight step would flap open/closed on every think→act boundary.
        live: running && endedAt === undefined,
      });
    } else {
      out.push(...run.map((msg) => ({ kind: "message" as const, msg })));
    }
    run = [];
  };

  for (const m of messages) {
    if (burstable(m)) run.push(m);
    else {
      flush(m.timestamp);
      out.push({ kind: "message", msg: m });
    }
  }
  flush();
  return out;
}
