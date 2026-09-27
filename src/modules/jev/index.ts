/**
 * Jev as the run's executor: the planner hands a routine stretch to the
 * `delegate` tool, Jev drives it step by step, and the planner checks the
 * result. Background-safe except `ui/`.
 */

export { handleDelegate, delegateSummary, delegateDetail } from "./delegate-tool";
export { jevForRun } from "./settings";
export type { DelegateData } from "./delegate-tool";
export type { JevConnection } from "./hosts";
