import type { ServerWebSocket } from "bun";
import {
  applyCompact,
  emptyStatus,
  type BridgeStatus,
  type DaemonMessage,
  type ExtensionMessage,
} from "./protocol";

/** A failure with a code the MCP layer turns into oriented text for the model. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const NOT_CONNECTED =
  "TabRunner isn't connected to this bridge.\n" +
  "Cause: the bridge is off, the extension isn't installed, its service worker is asleep, or it's pointed at another port.\n" +
  "Fix: enable the bridge under TabRunner's Settings → MCP, then open its side panel once to wake the worker. It reconnects on its own within ~30s. Call health again then.";

const WORKER_GONE =
  "The task stopped: Chrome suspended or restarted TabRunner's service worker while it was working.\n" +
  "Fix: send the task again with run. Keeping the side panel open while a long task runs prevents this.";

const TIMED_OUT =
  "TabRunner didn't answer in time. The browser may be busy or the worker may have been suspended mid-request.\n" +
  "Fix: call health to check the link, then retry.";

/** One request/response round trip. Long work is polled, never held open here. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * For lookups a caller would rather skip than wait for. health is a pre-flight
 * check — an answer that takes half a minute has already failed at its job.
 */
export const QUICK_TIMEOUT_MS = 4_000;
/** Keeps the socket warm and detects a half-open link between reconciles. */
const PING_MS = 20_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The daemon's half of the bridge: a localhost WebSocket server the extension
 * dials into, request/response correlation over it, and a mirror of the run
 * status that `get_status` serves — including while the extension is away, so a
 * dropped link never loses a finished run's answer.
 */
export class BridgeLink {
  private socket: ServerWebSocket<unknown> | null = null;
  private pending = new Map<string, Pending>();
  private waiters = new Set<() => void>();
  /** Bumped on every meaningful change — `get_status(wait)` parks until it moves. */
  private seq = 0;
  private listening = false;
  private bindError: string | null = null;

  status: BridgeStatus = emptyStatus();
  extension: { id: string; version: string } | null = null;

  constructor(private readonly port: number) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  get revision(): number {
    return this.seq;
  }

  /** Why the WS port isn't serving, if it isn't — surfaced by health. */
  get problem(): string | null {
    return this.listening ? null : this.bindError;
  }

  listen(): void {
    try {
      Bun.serve({
        port: this.port,
        hostname: "127.0.0.1",
        fetch: (req, server) => {
          if (server.upgrade(req)) return undefined;
          // A browser hitting the port by hand should learn what it found.
          return new Response("TabRunner MCP bridge. The extension connects here over /ws.\n", {
            headers: { "content-type": "text/plain" },
          });
        },
        websocket: {
          open: (ws) => this.onOpen(ws),
          message: (_ws, message) => this.onMessage(String(message)),
          close: (ws) => this.onClose(ws),
        },
      });
      this.listening = true;
      setInterval(
        () => this.socket?.send(JSON.stringify({ type: "ping" } satisfies DaemonMessage)),
        PING_MS,
      );
    } catch (e) {
      // Every MCP client spawns its own daemon process, so a second client finds
      // the port taken. Serving MCP anyway (and saying so) beats exiting: the
      // model gets an answer it can act on instead of a dead server.
      this.bindError =
        `Another TabRunner bridge is already listening on port ${this.port}, so this one can't reach the extension.\n` +
        `Cause: one daemon owns the port, and every MCP client starts its own.\n` +
        `Fix: drive the browser from the client that started first, or give this one its own port with TABRUNNER_BRIDGE_PORT (the extension's port setting must match).\n` +
        `Detail: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[tabrunner] ${this.bindError}`);
    }
  }

  /** Ask the extension to do something and wait for its answer. */
  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new BridgeError("no-extension", NOT_CONNECTED));
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError("timeout", TIMED_OUT));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: (v) => resolve(v as T), reject, timer });
      socket.send(
        JSON.stringify({ type: "request", requestId, method, params } satisfies DaemonMessage),
      );
    });
  }

  /**
   * Claim the run locally the moment the extension accepts it. The compact
   * event stream only reports progress, never "a run began" — without this the
   * buffer would still read `idle` while the browser was already working, and
   * `get_status` would tell the model nothing had started.
   */
  startRun(runId: string, conversationId: string): void {
    this.status = {
      ...emptyStatus(),
      state: "running",
      runId,
      conversationId,
      startedAt: Date.now(),
    };
    this.bump();
  }

  /** Back to a clean thread — the extension has dropped its conversation too. */
  reset(): void {
    this.status = emptyStatus();
    this.bump();
  }

  /**
   * Park until the run state moves past `sinceRevision`, or the wait runs out.
   * This is what keeps a ten-minute task from costing ten minutes of polling.
   */
  waitForChange(sinceRevision: number, timeoutMs: number): Promise<void> {
    if (this.seq !== sinceRevision) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  // ── Socket plumbing ───────────────────────────────────────────────

  private onOpen(ws: ServerWebSocket<unknown>): void {
    const previous = this.socket;
    this.socket = ws;
    // One extension at a time — a reconnect supersedes the socket it replaced.
    previous?.close();
    console.error("[tabrunner] extension connected");
  }

  private onClose(ws: ServerWebSocket<unknown>): void {
    // Only the current socket clears the slot: a superseded one closing later
    // must not disconnect the connection that replaced it.
    if (this.socket !== ws) return;
    this.socket = null;
    this.extension = null;
    console.error("[tabrunner] extension disconnected");
    this.bump();
  }

  private onMessage(raw: string): void {
    let msg: ExtensionMessage;
    try {
      msg = JSON.parse(raw) as ExtensionMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        this.extension = { id: msg.extensionId, version: msg.version };
        void this.resync();
        break;
      case "response": {
        const entry = this.pending.get(msg.requestId);
        if (!entry) return;
        this.pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else
          entry.reject(
            new BridgeError(
              msg.error?.code ?? "rejected",
              msg.error?.message ?? "TabRunner rejected the request.",
            ),
          );
        break;
      }
      case "event":
        if (applyCompact(this.status, msg.event)) this.bump();
        break;
      case "pong":
        break;
    }
  }

  /**
   * On every (re)connect, take the extension's own status as the truth. The run
   * survives a dropped link — but not a suspended worker, so a run that was live
   * here and is gone over there is reported as interrupted rather than left
   * polling a ghost forever.
   */
  private async resync(): Promise<void> {
    const previous = this.status;
    try {
      const fresh = await this.request<BridgeStatus>("sync");
      this.status =
        previous.state === "running" && fresh.runId !== previous.runId
          ? { ...previous, state: "error", error: WORKER_GONE, finishedAt: Date.now() }
          : fresh;
    } catch {
      // The link died again mid-sync; the next hello re-syncs.
    }
    this.bump();
  }

  private bump(): void {
    this.seq++;
    for (const wake of [...this.waiters]) wake();
  }
}
