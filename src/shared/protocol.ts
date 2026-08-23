/**
 * Port protocol — discriminated unions for the chrome.runtime.connect channel.
 * Commands flow side-panel → background; events flow background → side-panel.
 */

import type { TabId } from "./types";
import type { ErrorKind } from "@/modules/providers/error-classify";
import type { ReasoningEffort } from "@/modules/providers/types";
import type { RecordingStatus } from "@/modules/walkthrough/types";

// ── Commands (side panel → background) ──────────────────────────────

export type Command =
  /** images are data URLs the user attached; the task text references them as "[Image #1]";
   *  thisPage drives the user's current tab with the panel open; background drives the same
   *  tab but closes the panel after plan approval */
  | {
      type: "run";
      /** The conversation the task message was just stored in — the run's home.
       *  Carried, not re-derived worker-side: the shared active slot can be
       *  re-pointed (pill/notification click) between send and handling. */
      conversationId: string;
      task: string;
      images?: string[];
      thisPage?: boolean;
    }
  | { type: "stop" }
  /**
   * The panel naming the window it lives in, sent once right after connect.
   * "Is the user watching?" — the test every OS notification is gated on — has
   * to know WHICH window holds an open panel, not merely that one is open
   * somewhere: a panel open in the window behind is as unseen as a closed one.
   */
  | { type: "hello"; windowId: number }
  /**
   * Message typed while a run is in flight — the loop inserts it between tool
   * batches, so the model sees it in order without interrupting the run.
   */
  | { type: "inject"; id: string; text: string }
  /** The user edited or dropped a queued message before it was consumed. */
  | { type: "unqueue"; id: string }
  /** Cancel a run still waiting in the serial run queue (not the active one). */
  | { type: "cancel_queued"; id: string }
  /**
   * The user answered a plan-approval prompt — the loop resumes or ends on it.
   * `feedback` turns a "no" into a revision request: the run stays alive, the
   * model replans with the changes, and the revised plan is asked about again.
   */
  | { type: "plan_approval"; approved: boolean; feedback?: string }
  /** Ask what an external agent is doing in the browser — answered with run_active. */
  | { type: "query_run" }
  /**
   * Summarize the conversation so far and append the summary to its transcript,
   * so later runs replay the summary instead of a budget-trimmed slice of the
   * raw messages. The worker does the work: it owns transcript persistence, and
   * the panel may close before a summarization call comes back.
   */
  | { type: "compact" }
  /** Heartbeat — receiving it resets the worker's idle timer during long silences */
  | { type: "ping" };

// ── Events (background → side panel) ────────────────────────────────

/**
 * Payload shapes named once here — the agent loop and the panel store import
 * them instead of maintaining their own field-for-field copies.
 */

/** One finished tool call, as the panel renders it. */
export interface StepPayload {
  tool: string;
  summary: string;
  /** true = tool succeeded, false = tool failed, absent = neutral note (retry, warn) */
  ok?: boolean;
  /** Model-supplied arguments — the row's hint line and drill-down */
  args?: Record<string, unknown>;
  /** Result payload, truncated at the source. Behind a disclosure, never inline. */
  detail?: string;
  /** Screenshot data URLs — shown in the drill-down, dropped before storage */
  images?: string[];
}

/**
 * Which tab this run is driving — the panel is window-scoped and stays open
 * on every tab, so the run names its target instead of leaving it a mystery.
 */
export interface DrivingPayload {
  tabId: TabId;
  windowId: number;
  title: string;
  /** Hostname fallback for tabs that never set a title (PDFs, some file://). */
  url?: string;
  favIconUrl?: string;
}

/** The agent's checklist — replaces the previous one rather than appending. */
export interface PlanPayload {
  steps: string[];
  /** 0-based; equals steps.length once every step is finished. */
  current: number;
}

/**
 * A plan parked on the user's yes. A re-ask is the hard case: the run is already
 * mid-list, so the card has to say what is DONE (`current`) and what CHANGED
 * (`previous`) — without both it reads as a restart of work the user watched
 * happen.
 */
export interface PlanApprovalPayload extends PlanPayload {
  /** A mid-run change big enough to need a fresh yes, not the first ask. */
  reapproval: boolean;
  /** The steps of the last plan the user was shown at a gate — absent on the
   *  first ask, when there is nothing to diff against. */
  previous?: string[];
}

/**
 * An external client working in the browser — the bridge's delegated run, or a
 * direct-driving session. The panel shows this as a status band, because the
 * run it represents is already blinking the driven tab's favicon.
 */
export interface BridgeActive {
  /** run = a delegated task; direct = the client clicking through itself. */
  mode: "run" | "direct";
  /** The MCP client's name — the same label history shows on the thread. */
  client: string;
}

/**
 * The walkthrough a documented run left behind. Only the handle crosses the
 * wire — the frames are blobs in IndexedDB, which every extension context reads
 * for itself.
 */
export interface ArtifactPayload {
  recordingId: string;
  title: string;
  /** Documented steps, gaps included — what the card counts. */
  frames: number;
  status: RecordingStatus;
  sites: string[];
}

export type Event =
  /**
   * The resolved engine for this run — the concrete model id ("auto" is
   * already resolved) plus the effort when one is set. Emitted once, right
   * after provider setup, so the writer can stamp the run's summary with what
   * answered; the panel's display path ignores it (the composer chip shows the
   * live selection). The bridge's compact mirror drops it via its default case.
   */
  | { type: "engine"; model: string; effort?: ReasoningEffort }
  | ({ type: "driving" } & DrivingPayload)
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  /** A tool call is about to execute — the panel shows it as a live (spinning) row */
  | { type: "step_start"; tool: string; args?: Record<string, unknown> }
  | ({ type: "step" } & StepPayload)
  | ({ type: "plan" } & PlanPayload)
  | ({ type: "plan_approval" } & PlanApprovalPayload)
  /** A queued message was inserted into the conversation at a tool boundary */
  | { type: "injected"; id: string; text: string }
  /**
   * The steering messages still waiting at a tool boundary, answered on
   * `query_run`. The queue lives in the worker, but its cards live in the
   * panel — a panel that closed and came back would otherwise show none of
   * them while the worker still delivers every one, leaving the user with a
   * committed message they can no longer take back.
   */
  | { type: "queued_steers"; items: { id: string; text: string }[] }
  /** The submitted run is waiting in the serial queue — position is 1-based. */
  | { type: "run_queued"; id: string; position: number }
  | { type: "usage"; input: number; output: number }
  /** kind is the classified provider failure — the bubble then shows its own lead line, no generic hint */
  | {
      type: "error";
      message: string;
      kind?: ErrorKind;
      /** user-initiated ending (driven tab closed) — no notification */ silent?: boolean;
      /**
       * Nobody wrote copy for this one: a raw exception, or a provider failure
       * the classifier couldn't read — the same line loop.ts draws between
       * `log.warn` and `log.error`. Opt-in, so an anticipated condition added
       * later (a blocked page, a closed tab) never inherits it by default.
       * The bubble turns it into the "Report on GitHub" affordance.
       */
      unexpected?: boolean;
    }
  /** summary is the done tool's final answer — present when the model ends on a tool-only turn;
   *  question marks a run that ended on ask_user — its own notification already fired;
   *  stopped marks a user halt, so the settled band says "Stopped" and never claims "Done" */
  | { type: "done"; summary?: string; question?: boolean; stopped?: boolean }
  /** Who an external agent is in the browser — null when the browser is yours again */
  | { type: "run_active"; active: BridgeActive | null }
  /**
   * The run is documenting itself. Drives the REC state everywhere it shows —
   * the panel's run band, the driven tab's badge, the toolbar badge. Emitted
   * the moment the `document` tool arms, not at run start.
   */
  | { type: "recording"; on: boolean }
  /** A finished walkthrough — the run's deliverable, rendered as a card. */
  | ({ type: "artifact" } & ArtifactPayload)
  /**
   * A compaction finished. The summary message is already in storage (the panel
   * sees it through the transcript watch); these are the receipt's numbers, in
   * estimated tokens — `nothing` marks a conversation that was already short
   * enough, which is an answer, not a failure.
   */
  | { type: "compacted"; messages: number; before: number; after: number }
  | { type: "compact_failed"; message: string; nothing?: boolean };

// ── Port name ────────────────────────────────────────────────────────

export const PORT_NAME = "tabrunner";
