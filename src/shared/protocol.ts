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
  /** images are data URLs the user attached; the task text references them as "[Image #1]".
   *  Nothing here says foreground or background: every panel run drives the tab the user is
   *  on, and whether the panel stays open to watch it is the panel's own business. */
  | {
      type: "run";
      /** The conversation the task message was just stored in — the run's home.
       *  Carried, not re-derived worker-side: the shared active slot can be
       *  re-pointed (pill/notification click) between send and handling. */
      conversationId: string;
      task: string;
      images?: string[];
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
  /**
   * Ask what is live: an external agent in the browser (answered with
   * run_active), and — for the thread this panel is showing — its driven tab,
   * its spend, a parked plan gate and the steers still waiting.
   *
   * `conversationId` is optional because of when this is first sent: `attach()`
   * fires it before `connect()`'s stored-id read has resolved, so at that point
   * the panel does not yet know its own thread. Absent, the worker falls back
   * to the shared slot, which is what a panel opening now is about to load
   * anyway. A conversation switch names it — that is the ask whose answer must
   * be about the thread THIS panel just moved to, not whatever another window
   * pointed the slot at.
   */
  | { type: "query_run"; conversationId?: string }
  /**
   * Summarize the conversation so far and append the summary to its transcript,
   * so later runs replay the summary instead of a budget-trimmed slice of the
   * raw messages. The worker does the work: it owns transcript persistence, and
   * the panel may close before a summarization call comes back.
   *
   * The thread is named, never resolved from the shared slot: which transcript
   * gets folded is routing, and with a panel open in every window that slot is
   * whatever the last one of them opened.
   */
  | { type: "compact"; conversationId: string }
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
  /**
   * The gate was answered — by whichever panel clicked. The card is armed in
   * every panel showing the thread, so the answer has to reach every one of
   * them too: without this the windows that did not click keep a prompt for a
   * question already settled, which is what a second window used to show for
   * the rest of the run. `feedback` is a revision's note, rendered wherever the
   * card was (the panel that sent it persists it — this only draws it).
   */
  | { type: "plan_answered"; approved: boolean; feedback?: string }
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
  /**
   * The run's token spend SO FAR — running totals, not this turn's delta.
   * Absolute because a panel that opened mid-run has missed every delta and
   * would otherwise dress a live run in the last one's numbers; one of these
   * answers it completely, which is what `query_run` re-sends. `contextTokens`
   * is a different measurement riding along: the last turn's input, i.e. how
   * full the model's window is, which cumulative `input` cannot say.
   */
  | { type: "usage"; input: number; output: number; contextTokens: number }
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

/**
 * What actually crosses the port. The side panel is per-window, so a run's
 * events go to every open panel — `conversationId` says which thread they are
 * about, and a panel showing another one drops them. Absent means "for the
 * panel that asked": a reply to that panel's own command, which cannot be
 * misrouted because it was never broadcast.
 *
 * A stamp rather than an envelope, so an unstamped event still reads as a plain
 * `Event` at every handler.
 */
export type PanelMessage = Event & { conversationId?: string };

// ── Port name ────────────────────────────────────────────────────────

export const PORT_NAME = "tabrunner";
