/**
 * The run console's clock. One tick derives every state on screen, so the
 * phase maths lives here as a pure function — it is the piece that has to stay
 * honest (a run that names a step before it has planned reads as a fake).
 * Self-check: `bun run check`.
 */

export const CYCLE_MS = 12_000;
export const PLAN_AT = 1_400;
export const STEP_DONE_AT = [2_600, 4_200, 5_800, 9_200];
export const TOOL_AT = [2_600, 4_200, 5_800];
export const COMPOSING_AT = 7_400;
export const DONE_AT = 9_200;
export const TOTAL_TOKENS = 3_840;

export type RunPhase =
  | { kind: "planning" }
  | { kind: "step"; index: number }
  | { kind: "composing" }
  | { kind: "done" };

/** Which state the run is in at `tick` ms into the cycle. */
export function phaseAt(tick: number): RunPhase {
  if (tick >= DONE_AT) return { kind: "done" };
  if (tick >= COMPOSING_AT) return { kind: "composing" };
  // No plan yet means no step to name — the run is still planning.
  if (tick < PLAN_AT) return { kind: "planning" };
  return { kind: "step", index: STEP_DONE_AT.findIndex((at) => tick < at) };
}

/** Per-step marker state, driven by the same clock. */
export function stepStateAt(tick: number, i: number): "done" | "active" | "pending" {
  if (tick >= STEP_DONE_AT[i]) return "done";
  return i === 0 || tick >= STEP_DONE_AT[i - 1] ? "active" : "pending";
}

/** Spend rises with the run and lands on its total exactly as the run finishes. */
export function tokensAt(tick: number): number {
  return Math.round((Math.min(tick, DONE_AT) / DONE_AT) * (TOTAL_TOKENS / 8)) * 8;
}

export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
