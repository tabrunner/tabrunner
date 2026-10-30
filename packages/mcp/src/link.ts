import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { config } from "./config";
import {
  BRIDGE_PROTOCOL_VERSION,
  applyCompact,
  emptyStatus,
  type BridgeRunEvent,
  type BridgeStatus,
  type DaemonMessage,
} from "./protocol";

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

const LOST_CONNECTION =
  "The connection to TabRunner was lost before it answered. The request may already have changed the browser.\n" +
  "Fix: call health, then get_status or browser_snapshot to check what happened. Do not repeat the action until you have checked.";
const TIMED_OUT =
  "TabRunner didn't answer in time. The browser may be busy or the worker may have restarted. The request may already have changed the browser.\n" +
  "Fix: call health, then get_status or browser_snapshot to check the result before retrying.";
const TASK_INTERRUPTED =
  "TabRunner could not resume the previous task after reconnecting.\n" +
  "Fix: check the page before starting another task. Do not repeat an action until you know whether it already happened.";
const SYNC_PENDING =
  "TabRunner is connected, but this client's task status is not confirmed yet.\n" +
  "Cause: the status read is still pending or did not finish.\n" +
  "Fix: the bridge retries automatically. Call get_status or health again before repeating a task or browser action.";
const REQUEST_TIMEOUT_MS = 30_000;
export const QUICK_TIMEOUT_MS = 4_000;

const queueSchema = z.array(
  z.object({
    runId: z.string(),
    conversationId: z.string(),
    position: z.number(),
    task: z.string(),
    owner: z.enum(["panel", "bridge", "schedule"]),
  }),
);
const compactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), runId: z.string(), conversationId: z.string() }),
  z.object({ type: z.literal("step_start"), tool: z.string() }),
  z.object({
    type: z.literal("step"),
    tool: z.string(),
    summary: z.string(),
    ok: z.boolean().optional(),
  }),
  z.object({ type: z.literal("plan"), steps: z.array(z.string()), current: z.number() }),
  z.object({
    type: z.literal("driving"),
    tabId: z.number(),
    windowId: z.number(),
    title: z.string(),
  }),
  z.object({ type: z.literal("queue"), queue: queueSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done"), summary: z.string().optional() }),
  z.object({
    type: z.literal("question"),
    question: z.string(),
    choices: z.array(z.string()).optional(),
  }),
]);
const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    extensionId: z.string(),
    version: z.string(),
    protocolVersion: z.number().optional(),
  }),
  z.object({ type: z.literal("pong") }),
  z.object({
    type: z.literal("response"),
    clientId: z.string(),
    requestId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("event"),
    clientId: z.string(),
    runId: z.string().nullable(),
    conversationId: z.string().nullable(),
    event: compactSchema,
  }),
]);
const statusSchema = z.object({
  conversationId: z.string().nullable(),
  runId: z.string().nullable(),
  state: z.enum(["idle", "running", "question", "done", "error"]),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  steps: z.array(z.object({ tool: z.string(), summary: z.string(), ok: z.boolean().optional() })),
  plan: z.object({ steps: z.array(z.string()), current: z.number() }).nullable(),
  driving: z.object({ tabId: z.number(), windowId: z.number(), title: z.string() }).nullable(),
  queue: queueSchema,
  question: z.string().nullable(),
  choices: z.array(z.string()).nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
});

interface Pending {
  clientId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One MCP session's mirror and request scope. Names never identify a client. */
export class ClientBridgeLink {
  status: BridgeStatus = emptyStatus();
  private seq = 0;
  private waiters = new Set<() => void>();
  private queuedRuns = new Set<string>();
  private seenRuns = new Set<string>();
  private pendingStarts = 0;
  private syncRequired = true;
  private syncEpoch = 0;
  private syncing: Promise<void> | null = null;
  closed = false;

  constructor(
    readonly clientId: string,
    private readonly owner: BridgeLink,
  ) {}

  get connected(): boolean {
    return this.owner.connected;
  }
  get extension() {
    return this.owner.extension;
  }
  get problem(): string | null {
    return this.owner.problem ?? (this.connected && this.syncRequired ? SYNC_PENDING : null);
  }
  get port(): number {
    return config.port;
  }
  get expectedExtensionId(): string {
    return config.expectedExtensionId;
  }
  get revision(): number {
    return this.seq;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    targetRunId?: string,
  ): Promise<T> {
    if (this.closed)
      throw new BridgeError(
        "closed-client",
        "This MCP session has closed. Restart this MCP client to connect again.",
      );
    const starts = method === "run" || method === "answer" || method === "browserStart";
    if (starts) this.pendingStarts++;
    try {
      return await this.owner.request<T>(
        this.clientId,
        method,
        params,
        timeoutMs,
        targetRunId ??
          (method === "run" ||
          method === "browserStart" ||
          method === "sync" ||
          method === "providerInfo"
            ? undefined
            : (this.status.runId ?? undefined)),
      );
    } finally {
      if (starts) this.pendingStarts--;
    }
  }

  startRun(runId: string, conversationId: string, queued?: number): void {
    if (queued !== undefined) {
      this.queuedRuns.add(runId);
      this.bump();
      return;
    }
    if (this.status.runId === runId) return;
    this.seenRuns.add(runId);
    this.status = {
      ...emptyStatus(),
      queue: this.status.queue,
      state: "running",
      runId,
      conversationId,
      startedAt: Date.now(),
    };
    this.bump();
  }

  forgetRun(runId: string): void {
    this.queuedRuns.delete(runId);
    this.seenRuns.add(runId);
    this.bump();
  }

  reset(): void {
    this.status = emptyStatus();
    this.queuedRuns.clear();
    this.bump();
  }

  event(message: BridgeRunEvent): void {
    const { event, runId, conversationId } = message;
    if (event.type === "queue") {
      for (const entry of event.queue) this.queuedRuns.add(entry.runId);
    }
    if (event.type === "started") {
      if (runId !== event.runId || conversationId !== event.conversationId) return;
      if (runId === this.status.runId) return;
      if (!this.queuedRuns.has(runId) && !(this.pendingStarts > 0 && !this.seenRuns.has(runId)))
        return;
      this.queuedRuns.delete(runId);
      this.seenRuns.add(runId);
    } else if (
      event.type !== "queue" &&
      (runId !== this.status.runId ||
        conversationId !== this.status.conversationId ||
        runId === null)
    )
      return;
    if (applyCompact(this.status, event)) this.bump();
  }

  markSyncPending(): void {
    this.syncRequired = true;
    this.syncEpoch++;
    this.bump();
  }

  /** Retry only the safe status read, once at a time, until the mirror is current. */
  resync(): Promise<void> {
    if (this.closed || !this.connected || !this.syncRequired) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const previous = structuredClone(this.status);
    const revision = this.seq;
    const epoch = this.syncEpoch;
    this.syncing = (async () => {
      try {
        const fresh = statusSchema.parse(await this.request<unknown>("sync", {}, QUICK_TIMEOUT_MS));
        // A newer connection, run receipt or live event owns the mirror now.
        if (this.closed || epoch !== this.syncEpoch || revision !== this.seq) return;
        this.status =
          previous.state === "running" && fresh.runId === null
            ? {
                ...previous,
                runId: fresh.runId,
                conversationId: fresh.conversationId ?? previous.conversationId,
                queue: fresh.queue,
                state: "error",
                error: TASK_INTERRUPTED,
                finishedAt: Date.now(),
              }
            : fresh;
        if (fresh.runId) this.seenRuns.add(fresh.runId);
        this.queuedRuns = new Set(fresh.queue.map((entry) => entry.runId));
        this.syncRequired = false;
        this.bump();
      } catch {
        // The next heartbeat or status read retries. Browser actions are never replayed.
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  waitForChange(sinceRevision: number, timeoutMs: number): Promise<void> {
    if (this.seq !== sinceRevision || this.closed) return Promise.resolve();
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

  bump(): void {
    this.seq++;
    for (const wake of [...this.waiters]) wake();
  }
}

/** One elected broker owns the extension socket. Every MCP session gets its own link. */
export class BridgeLink {
  private socket: ServerWebSocket<undefined> | null = null;
  private listener: Server<undefined> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, Pending>();
  private clients = new Map<string, ClientBridgeLink>();
  private closing = new Map<string, () => void>();
  private closingRequests = new Set<string>();
  extension: { id: string; version: string } | null = null;
  problem: string | null = null;

  get connected(): boolean {
    return this.socket !== null && this.extension !== null;
  }

  listen(): void {
    this.listener = Bun.serve<undefined>({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: (req, server) => {
        if (new URL(req.url).pathname !== "/ws") return new Response("Not found", { status: 404 });
        if (
          req.headers.get("host") !== `127.0.0.1:${config.port}` ||
          req.headers.get("origin") !== `chrome-extension://${config.expectedExtensionId}`
        )
          return new Response("Only the configured TabRunner extension can connect.", {
            status: 403,
          });
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("WebSocket required", { status: 400 });
      },
      websocket: {
        open: () => {},
        message: (ws, message) => this.onMessage(ws, String(message)),
        close: (ws) => this.onClose(ws),
      },
    });
    this.pingTimer = setInterval(() => {
      this.ping();
      for (const client of this.clients.values()) void client.resync();
      for (const clientId of this.closing.keys()) this.drainClient(clientId);
    }, config.pingMs);
  }

  createClient(clientId: string): ClientBridgeLink {
    const client = new ClientBridgeLink(clientId, this);
    this.clients.set(clientId, client);
    if (this.connected) {
      this.ping();
      void client.resync();
    }
    return client;
  }

  closeClient(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return Promise.resolve();
    this.clients.delete(clientId);
    client.closed = true;
    client.bump();
    this.rejectPending(clientId);
    // A client that never reached an extension has nothing there to drain.
    if (!this.extension && !this.socket && !this.everConnected) return Promise.resolve();
    const drained = new Promise<void>((resolve) => this.closing.set(clientId, resolve));
    this.ping();
    this.drainClient(clientId);
    return drained;
  }

  private everConnected = false;

  private drainClient(clientId: string): void {
    if (!this.connected || this.closingRequests.has(clientId)) return;
    this.closingRequests.add(clientId);
    void this.request(clientId, "closeClient")
      .then(() => {
        this.closing.get(clientId)?.();
        this.closing.delete(clientId);
      })
      .catch(() => {
        // Only cleanup is retried after reconnect. No browser mutation is replayed.
      })
      .finally(() => this.closingRequests.delete(clientId));
  }

  request<T>(
    clientId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    runId?: string,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.connected)
      return Promise.reject(new BridgeError("no-extension", this.problem ?? NOT_CONNECTED));
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError("timeout", TIMED_OUT));
      }, timeoutMs);
      this.pending.set(requestId, {
        clientId,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(
        JSON.stringify({
          type: "request",
          clientId,
          requestId,
          method,
          params,
          ...(runId ? { runId } : {}),
        } satisfies DaemonMessage),
      );
    });
  }

  private ping(): void {
    if (this.connected)
      this.socket?.send(
        JSON.stringify({
          type: "ping",
          clientIds: [...this.clients.keys()],
        } satisfies DaemonMessage),
      );
  }

  private onClose(ws: ServerWebSocket<undefined>): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.extension = null;
    this.rejectPending();
    for (const client of this.clients.values()) client.markSyncPending();
  }

  private rejectPending(clientId?: string): void {
    for (const [id, pending] of this.pending) {
      if (clientId !== undefined && pending.clientId !== clientId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new BridgeError("connection-lost", LOST_CONNECTION));
    }
  }

  private onMessage(ws: ServerWebSocket<undefined>, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = messageSchema.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;
    if (msg.type === "hello") {
      if (
        msg.extensionId !== config.expectedExtensionId ||
        msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      ) {
        if (!this.connected)
          this.problem = `TabRunner's extension and MCP bridge do not match (bridge protocol ${BRIDGE_PROTOCOL_VERSION}, extension protocol ${msg.protocolVersion ?? "missing"}). Update the extension and MCP client, then reconnect.`;
        ws.close(1008, "TabRunner bridge version or extension mismatch");
        return;
      }
      if (this.socket !== ws) {
        this.rejectPending();
        this.socket?.close();
        this.socket = ws;
      }
      this.everConnected = true;
      this.extension = { id: msg.extensionId, version: msg.version };
      this.problem = null;
      this.ping();
      for (const client of this.clients.values()) {
        client.markSyncPending();
        void client.resync();
      }
      for (const clientId of this.closing.keys()) this.drainClient(clientId);
      return;
    }
    if (this.socket !== ws || !this.connected) return;
    if (msg.type === "event") this.clients.get(msg.clientId)?.event(msg);
    if (msg.type === "response") {
      const pending = this.pending.get(msg.requestId);
      if (!pending || pending.clientId !== msg.clientId) return;
      this.pending.delete(msg.requestId);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else
        pending.reject(
          new BridgeError(
            msg.error?.code ?? "rejected",
            msg.error?.message ??
              "TabRunner rejected the request. Call health, check the current page and try again.",
          ),
        );
    }
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.rejectPending();
    this.socket?.close();
    await this.listener?.stop(true);
  }
}
