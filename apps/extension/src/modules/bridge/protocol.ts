/**
 * Bridge wire protocol — the WebSocket channel between the extension and the
 * local MCP daemon. The extension is always the WS *client* (an MV3 service
 * worker cannot listen on a socket); the daemon accepts, hosts MCP, and makes
 * requests. The daemon re-declares this shape in its own package — it is a
 * standalone bun script and must not import from the extension bundle.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;

// ── Extension → daemon ──────────────────────────────────────────────

/** Handshake on (re)connect — the daemon recognizes us and re-syncs its status. */
export interface BridgeHello {
  type: "hello";
  extensionId: string;
  version: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
}

export interface BridgePong {
  type: "pong";
}

/** Reply to a daemon request, correlated by requestId. */
export interface BridgeResponse {
  type: "response";
  requestId: string;
  clientId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One run event the daemon turns into status + progress. Compact on purpose:
 *  token deltas and reasoning never cross the wire. */
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

/** A request from the daemon; method is one of the bridge commands below. */
export interface BridgeRequest {
  type: "request";
  requestId: string;
  clientId: string;
  runId?: string;
  method: string;
  params: Record<string, unknown>;
}

export type DaemonMessage = BridgePing | BridgeRequest;

// ── Compact run events (extension → daemon) ─────────────────────────

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

// ── Provider readiness (serves health) ──────────────────────────────

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

// ── Run status (serves getStatus + sync rebuild) ────────────────────

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
  /** This client's waiting tasks, in submission order. */
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
