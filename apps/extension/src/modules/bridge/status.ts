import type { Event } from "@/shared/protocol";
import type { BridgeStatus, CompactRunEvent } from "./protocol";

/**
 * The compact run state served by getStatus and rebuilt on daemon reconnect.
 * Both the extension and the daemon keep one of these; the daemon's copy is a
 * mirror kept by the same reduction (see daemon/src/status.ts).
 */

export function emptyStatus(): BridgeStatus {
  return {
    conversationId: null,
    runId: null,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    steps: [],
    plan: null,
    driving: null,
    queue: [],
    question: null,
    choices: null,
    error: null,
    summary: null,
  };
}

/** A fresh running slot — called the moment a run is claimed, before its first event. */
export function newRunStatus(conversationId: string, runId: string): BridgeStatus {
  return {
    ...emptyStatus(),
    conversationId,
    runId,
    state: "running",
    startedAt: Date.now(),
  };
}

/**
 * Fold one run event into the status and return the compact event to forward.
 * Token/reasoning/usage/injected never change status and forward nothing.
 */
export function applyStatusEvent(status: BridgeStatus, event: Event): CompactRunEvent | null {
  switch (event.type) {
    case "driving":
      status.driving = { tabId: event.tabId, windowId: event.windowId, title: event.title };
      return { type: "driving", tabId: event.tabId, windowId: event.windowId, title: event.title };
    case "step_start":
      return { type: "step_start", tool: event.tool };
    case "step":
      status.steps.push({ tool: event.tool, summary: event.summary, ok: event.ok });
      return { type: "step", tool: event.tool, summary: event.summary, ok: event.ok };
    case "plan":
      status.plan = { steps: event.steps, current: event.current };
      return { type: "plan", steps: event.steps, current: event.current };
    case "error":
      status.state = "error";
      status.error = event.message;
      status.finishedAt = Date.now();
      return { type: "error", message: event.message };
    case "done":
      // A question ends the run too (ask_user is run-terminating) — the done
      // that follows it must not overwrite the question as the closing state.
      if (status.state !== "question") {
        status.state = "done";
        status.summary = event.summary ?? null;
      }
      status.finishedAt = Date.now();
      return { type: "done", summary: event.summary };
    default:
      return null;
  }
}

/** The run ended on an ask_user question — state "question" until answer() lands. */
export function applyQuestion(status: BridgeStatus, question: string, choices?: string[]): void {
  status.state = "question";
  status.question = question;
  status.choices = choices ?? null;
  status.finishedAt = Date.now();
}
