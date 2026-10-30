/**
 * Bridge wire protocol — the daemon's copy.
 *
 * Deliberately duplicated from `apps/extension/src/modules/bridge/protocol.ts`: the daemon is
 * a standalone bun program with its own package.json, and importing across that
 * line would drag the extension's `@/` aliases and DOM types into a server. The
 * two copies must change together — the extension's file is the source of truth.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;

// ── Extension → daemon ──────────────────────────────────────────────

export interface BridgeHello {
  type: "hello";
  extensionId: string;
  version: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
}

export interface BridgePong {
  type: "pong";
}

export interface BridgeResponse {
  type: "response";
  requestId: string;
  clientId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface BridgeRunEvent {
  type: "event";
  clientId: string;
  runId: string | null;
  conversationId: string | null;
  event: CompactRunEvent;
}

export type ExtensionMessage = BridgeHello | BridgePong | BridgeResponse | BridgeRunEvent;

// ── Daemon → extension ──────────────────────────────────────────────

export interface BridgePing {
  type: "ping";
  clientIds: string[];
}

export interface BridgeRequest {
  type: "request";
  requestId: string;
  clientId: string;
  runId?: string;
  method: string;
  params: Record<string, unknown>;
}

export type DaemonMessage = BridgePing | BridgeRequest;

// ── Run events and status ───────────────────────────────────────────

export type CompactRunEvent =
  /** A queued run claimed the status slot — the mirror resets to a fresh running state. */
  | { type: "started"; runId: string; conversationId: string }
  | { type: "step_start"; tool: string }
  | { type: "step"; tool: string; summary: string; ok?: boolean }
  | { type: "plan"; steps: string[]; current: number }
  | { type: "driving"; tabId: number; windowId: number; title: string }
  | { type: "queue"; queue: BridgeQueueEntry[] }
  | { type: "error"; message: string }
  | { type: "done"; summary?: string }
  | { type: "question"; question: string; choices?: string[] };

/**
 * The model side of "can a task actually run", answered before one is sent.
 * The browser link being up says nothing about whether TabRunner has a model to
 * think with, and finding that out from a failed run wastes the user's turn.
 */
export interface BridgeProviderInfo {
  /** Display name of the active provider; null when none is configured. */
  name: string | null;
  /** Whether its credential is usable — false means it needs a key or a sign-in. */
  ready: boolean;
  /** How it authenticates, so the fix can name the right one. */
  auth: "key" | "subscription" | null;
  /** The pinned model id, or null for auto (resolved at run start). */
  model: string | null;
}

/** One waiting run, as get_status lists it. Position is 1-based, FIFO. */
export interface BridgeQueueEntry {
  runId: string;
  conversationId: string;
  position: number;
  task: string;
  /** All entries belong to the caller, never another client's work. */
  owner: "panel" | "bridge" | "schedule";
}

export interface BridgeStatus {
  conversationId: string | null;
  runId: string | null;
  state: "idle" | "running" | "question" | "done" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  steps: { tool: string; summary: string; ok?: boolean }[];
  plan: { steps: string[]; current: number } | null;
  driving: { tabId: number; windowId: number; title: string } | null;
  /** This client's runs waiting for a browser slot. */
  queue: BridgeQueueEntry[];
  question: string | null;
  /**
   * The tappable options the panel would show, when the answer is one of a few
   * concrete ones — null for an open answer. A client relaying the question has
   * to be able to relay what the model expects back, or it invents its own
   * wording for options the run is waiting on verbatim.
   */
  choices: string[] | null;
  error: string | null;
  summary: string | null;
}

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

/** The screenshot payload the extension answers `screenshot` with. */
export interface CaptureResult {
  dataUrl: string;
  tabId: number;
  title: string;
  url: string;
  /** false when the captured tab isn't the one the agent is driving. */
  driven: boolean;
}

/**
 * Fold one pushed event into the local status mirror. The extension runs the
 * same reduction over its richer event stream (`apps/extension/src/modules/bridge/status.ts`);
 * this side only ever sees the compact form, so a dropped connection costs
 * nothing a `sync` can't rebuild.
 *
 * Returns true when the change is one a waiting `get_status` should wake for —
 * `step_start` alone is noise, everything else is progress worth a turn.
 */
export function applyCompact(status: BridgeStatus, event: CompactRunEvent): boolean {
  switch (event.type) {
    case "started":
      // A queued run took the slot: without this reset its events would fold
      // into the previous run's terminal mirror — and its final done would be
      // swallowed by the question guard below. The queue is preserved: the
      // extension's queue event lands right behind and re-lists it.
      Object.assign(status, emptyStatus(), {
        queue: status.queue,
        conversationId: event.conversationId,
        runId: event.runId,
        state: "running" as const,
        startedAt: Date.now(),
      });
      return true;
    case "step_start":
      return false;
    case "step":
      status.steps.push({ tool: event.tool, summary: event.summary, ok: event.ok });
      return true;
    case "plan":
      status.plan = { steps: event.steps, current: event.current };
      return true;
    case "driving":
      status.driving = { tabId: event.tabId, windowId: event.windowId, title: event.title };
      return true;
    case "queue":
      status.queue = event.queue;
      return true;
    case "question":
      status.state = "question";
      status.question = event.question;
      status.choices = event.choices ?? null;
      status.finishedAt = Date.now();
      return true;
    case "error":
      status.state = "error";
      status.error = event.message;
      status.finishedAt = Date.now();
      return true;
    case "done":
      // ask_user ends the run too, and its `done` arrives right behind the
      // question — it must not overwrite the question as the closing state.
      if (status.state !== "question") {
        status.state = "done";
        status.summary = event.summary ?? null;
      }
      status.finishedAt = Date.now();
      return true;
  }
}
