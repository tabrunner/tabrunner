import { createLogger, truncate } from "@/lib/logger";
import {
  SseFrameReader,
  classifyMessage,
  declineResponse,
  methodNotFoundResponse,
  notification,
  request,
} from "./jsonrpc";
import type { McpAdvertisedTool, McpCallResult } from "./types";

/**
 * The Streamable HTTP transport: one McpSession per server per run. Hand-rolled
 * against the wire (POST JSON-RPC, answers come back as JSON or an SSE stream)
 * because the official SDK assumes Node APIs this worker doesn't have — the
 * transport itself is just fetch.
 *
 * Lazy by design: a session exists for one run and dies with it. Nothing
 * listens between runs, so server push outside a call goes unseen — accepted;
 * the tools a run uses are snapshotted at its start anyway.
 *
 * The state machine: initialize → ready → call → close. A 404 or a JSON-RPC
 * -32001/-32000 mid-run means the server dropped our session; ONE reinitialize
 * + retry is attempted per call, then the call fails as an error result.
 * callTool never throws into the agent loop — worst case it resolves an
 * isError result. listTools/initialize DO throw; their callers own the UI.
 */

const log = createLogger("mcp");

/** Server→client requests we answer. Everything else gets -32601 — we declare
 *  only what we can honor, but non-compliant servers ask anyway. */
const SERVER_REQUEST_METHODS = new Set(["elicitation/create"]);

const MCP_PROTOCOL_VERSION = "2025-06-18";

const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 90_000;
const ANSWER_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;

class SessionExpired extends Error {}
export class McpConnectError extends Error {}
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    snippet: string,
  ) {
    super(`HTTP ${status}: ${truncate(snippet)}`);
  }
}

/** What the caller supplies to answer a server→client request. Returning
 *  "decline" sends the protocol's decline result; anything else IS the result. */
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
) => Promise<"decline" | Record<string, unknown>>;

export interface McpSessionOptions {
  url: string;
  headers?: Record<string, string>;
  onRequest?: ServerRequestHandler;
  /** Test seam — production callers take the defaults. */
  initTimeoutMs?: number;
  callTimeoutMs?: number;
}

export class McpSession {
  #nextId = 1;
  #sessionId: string | undefined;
  #protocolVersion = MCP_PROTOCOL_VERSION;
  #closed = false;
  /** Single-flight re-handshake — overlapping expired calls share one. */
  #reinit: Promise<void> | undefined;

  constructor(private readonly opts: McpSessionOptions) {}

  /**
   * Handshake. Resolves ready; throws on any failure so the snapshot phase can
   * stamp the server's status row and move on.
   */
  async initialize(): Promise<void> {
    const { result, sessionId } = await this.#exchange(
      request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "TabRunner", version: "0" },
        },
        this.#nextId++,
      ),
      this.opts.initTimeoutMs ?? INIT_TIMEOUT_MS,
    );
    if (sessionId) this.#sessionId = sessionId;
    if (isRecord(result) && typeof result.protocolVersion === "string")
      this.#protocolVersion = result.protocolVersion;
    log.info("initialized", redactUrl(this.opts.url), this.#protocolVersion);

    // Best-effort: some servers 4xx or 405 the notification, which is allowed.
    await this.#fireAndForget(notification("notifications/initialized"));
  }

  /** Advertised tools. Throws — the run snapshot owns failure presentation. */
  async listTools(signal?: AbortSignal): Promise<McpAdvertisedTool[]> {
    const result = await this.#withReinit(() =>
      this.#exchange(request("tools/list", {}, this.#nextId++), INIT_TIMEOUT_MS, { signal }),
    );
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.filter(isRecord).map((t) => ({
      name: typeof t.name === "string" ? t.name : "",
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: isRecord(t.inputSchema) ? t.inputSchema : undefined,
    }));
  }

  /** Execute one tool. Always resolves a result; never throws except when the
   *  CALLER's own signal aborted the call. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    try {
      const result = await this.#withReinit(() =>
        this.#exchange(
          request("tools/call", { name: toolName, arguments: args }, this.#nextId++),
          this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
          { signal },
        ),
      );
      return toCallResult(result);
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      };
    }
  }

  /** Best-effort DELETE of the server-side session. */
  async close(): Promise<void> {
    if (this.#closed || !this.#sessionId) return;
    this.#closed = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOSE_TIMEOUT_MS);
    try {
      await fetch(this.opts.url, {
        method: "DELETE",
        headers: this.#headers(),
        signal: controller.signal,
      });
    } catch {
      // The session expires server-side on its own; nothing to do here.
    } finally {
      clearTimeout(timer);
    }
  }

  // --- internals ---

  /** One round-trip with a single re-handshake+retry when the session died.
   *  Unwraps #exchange's envelope — callers want the JSON-RPC result alone. */
  async #withReinit(
    exchange: () => Promise<{ result: unknown; sessionId?: string }>,
  ): Promise<unknown> {
    try {
      return (await exchange()).result;
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      await this.reinitialize();
      return (await exchange()).result;
    }
  }

  async reinitialize(): Promise<void> {
    this.#reinit ??= this.initialize().catch((e: unknown) => {
      throw new SessionExpired(`reinitialize failed: ${e instanceof Error ? e.message : e}`);
    });
    try {
      await this.#reinit.finally(() => (this.#reinit = undefined));
    } catch (e) {
      // Surface as expiry so the caller's retry policy sees one uniform story.
      throw e instanceof SessionExpired ? e : new SessionExpired(String(e));
    }
  }

  /**
   * POST one message and resolve the RESULT of the reply. An SSE body may
   * interleave our reply with other calls' replies, notifications and
   * server→client REQUESTS — those dispatch while we pump, each answered on
   * its own POST, until the frame carrying our id arrives. A stream that ends
   * first is the protocol's "connection closed": session expired.
   */
  async #exchange(
    body: string,
    timeoutMs: number,
    o: { signal?: AbortSignal; expectId?: number } = {},
  ): Promise<{ result: unknown; sessionId?: string }> {
    const expectId = o.expectId ?? extractId(body);
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...this.#headers() },
        body,
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
    } catch (e) {
      throw isAbortError(e) ? e : new McpConnectError(String(e));
    }

    if (res.status === 404) throw new SessionExpired();
    if (res.status >= 400)
      throw new McpHttpError(res.status, truncate(await res.text().catch(() => ""), 300));

    const sessionId = res.headers.get("mcp-session-id") ?? undefined;
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.body) return { result: {}, sessionId }; // 202 Accepted, nothing to read

    if (contentType.includes("text/event-stream"))
      return { result: await this.#pumpSse(res.body, expectId), sessionId };
    const message = safeJson(await res.text().catch(() => ""));
    return { result: this.#settled(message, expectId), sessionId };
  }

  /** Interpret one already-parsed JSON-RPC response envelope. */
  #settled(message: unknown, expectId: number): unknown {
    if (!isRecord(message)) throw new McpConnectError("unparseable response body");
    if (isRecord(message.error)) {
      const code = message.error.code;
      if (code === -32001 || code === -32000)
        throw new SessionExpired(str(message.error.message) || "session closed");
      throw new McpHttpError(200, str(message.error.message) || "JSON-RPC error");
    }
    if (message.id !== undefined && message.id !== expectId)
      log.debug("ignoring response for another request", String(message.id));
    return message.result;
  }

  #pumpSse(body: ReadableStream<Uint8Array>, expectId: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reader = new SseFrameReader();
      const decoder = new TextDecoder();
      const stream = body.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await stream.read();
            if (done) break;
            for (const msg of reader.push(decoder.decode(value, { stream: true }))) {
              const routed = this.#route(msg, expectId, resolve, reject);
              if (routed) return;
            }
          }
          for (const msg of reader.end()) {
            const routed = this.#route(msg, expectId, resolve, reject);
            if (routed) return;
          }
          reject(new SessionExpired());
        } catch (e) {
          reject(e);
        } finally {
          stream.releaseLock();
        }
      })();
    });
  }

  /** Route one parsed frame. True = the pending round-trip is settled. */
  #route(
    msg: unknown,
    expectId: number,
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ): boolean {
    switch (classifyMessage(msg)) {
      case "response": {
        const m = msg as Record<string, unknown>;
        if (m.id !== expectId) return false; // another concurrent call's reply
        try {
          resolve(this.#settled(m, expectId));
        } catch (e) {
          reject(e);
        }
        return true;
      }
      case "request":
        void this.#answerServerRequest(msg as Record<string, unknown>);
        return false;
      case "notification":
        log.debug("notification:", truncate(JSON.stringify(msg), 200));
        return false;
      default:
        return false;
    }
  }

  /** Answer a server→client request on its own POST, best-effort. */
  async #answerServerRequest(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as number | string;
    const method = typeof msg.method === "string" ? msg.method : "";
    let body: string;
    if (!SERVER_REQUEST_METHODS.has(method) || !this.opts.onRequest) {
      body = methodNotFoundResponse(id, method);
    } else {
      try {
        const answer = await this.opts.onRequest(method, isRecord(msg.params) ? msg.params : undefined);
        body =
          answer === "decline"
            ? declineResponse(id)
            : JSON.stringify({ jsonrpc: "2.0", id, result: answer });
      } catch {
        body = declineResponse(id);
      }
    }
    try {
      await this.#fireAndForget(body);
    } catch (e) {
      log.warn("failed to answer server request:", e instanceof Error ? e.message : String(e));
    }
  }

  /** POST without waiting on the content — notifications, answers. */
  async #fireAndForget(body: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
    try {
      await fetch(this.opts.url, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...this.#headers() },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = {
      "mcp-protocol-version": this.#protocolVersion,
      ...(this.opts.headers ?? {}),
    };
    if (this.#sessionId !== undefined) h["mcp-session-id"] = this.#sessionId;
    return h;
  }
}

// --- module-local helpers ---

function toCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) return { isError: false, content: [] };
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  return {
    isError: result.isError === true,
    content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

/** Pull the request id back out of a serialized body so callers needn't thread it. */
function extractId(body: string): number {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "number" ? parsed.id : -1;
  } catch {
    return -1;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function redactUrl(url: string): string {
  return url.replace(/\?.*$/, "").replace(/\/\/[^/]*@/, "//");
}
