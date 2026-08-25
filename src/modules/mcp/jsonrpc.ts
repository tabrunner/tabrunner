/**
 * JSON-RPC 2.0 framing for the Streamable HTTP wire — pure, no fetch, no ids
 * of its own (the session owns the counter and passes one in). Messages stay
 * untyped past these builders: classification (`classifyMessage`) plus the
 * session's own narrow reads beat re-declaring the whole envelope.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const METHOD_NOT_FOUND = -32601;

export function request(
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
): string {
  return JSON.stringify(
    params ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method },
  );
}

export function notification(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

function errorResponse(id: number | string, error: JsonRpcError): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error });
}

/** The answer to a server→client request we never declared a capability for. */
export function methodNotFoundResponse(id: number | string, method: string): string {
  return errorResponse(id, { code: METHOD_NOT_FOUND, message: `Method not supported: ${method}` });
}

/** The decline answer for elicitation requests nobody is present to answer. */
export function declineResponse(id: number | string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { action: "decline" },
  });
}

export type MessageKind = "response" | "request" | "notification" | "invalid";

/** Sort a parsed SSE/JSON payload into what the session's pump needs to do. */
export function classifyMessage(msg: unknown): MessageKind {
  if (typeof msg !== "object" || msg === null) return "invalid";
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return "invalid";
  const hasId = typeof m.id === "number" || typeof m.id === "string";
  if (typeof m.method === "string") return hasId ? "request" : "notification";
  if (hasId && ("result" in m || "error" in m)) return "response";
  return "invalid";
}

/**
 * Incremental reader for an SSE body: feed it every decoded chunk, it returns
 * each complete `data:` frame's parsed payload. Frames end at a blank line;
 * multi-line `data:` fields join with newlines before parsing. Unparseable
 * payloads are skipped — a server may interleave keepalive comments, which
 * simply produce nothing.
 */
export class SseFrameReader {
  #buffer = "";
  #frame: string[] = [];

  push(text: string): unknown[] {
    this.#buffer += text;
    const out: unknown[] = [];
    let start = 0;
    while (true) {
      const nl = this.#buffer.indexOf("\n", start);
      if (nl < 0) break;
      const line = this.#buffer.slice(start, nl).replace(/\r$/, "");
      start = nl + 1;
      if (line === "") {
        out.push(...this.#flushFrame());
      } else if (line.startsWith("data:")) {
        this.#frame.push(line.slice(5).trimStart());
      }
      // `event:` / `id:` / comments (`:`) carry nothing we need.
    }
    this.#buffer = this.#buffer.slice(start);
    return out;
  }

  /** Flush a body that ended mid-frame: the leftover buffer is one last line. */
  end(): unknown[] {
    const out: unknown[] = [];
    if (this.#buffer !== "") {
      const line = this.#buffer.replace(/\r$/, "");
      this.#buffer = "";
      if (line === "") {
        out.push(...this.#flushFrame());
      } else {
        if (line.startsWith("data:")) this.#frame.push(line.slice(5).trimStart());
        out.push(...this.#flushFrame());
      }
    }
    return out;
  }

  #flushFrame(): unknown[] {
    if (this.#frame.length === 0) return [];
    const raw = this.#frame.join("\n");
    this.#frame = [];
    try {
      return [JSON.parse(raw)];
    } catch {
      return [];
    }
  }
}
