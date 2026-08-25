import { describe, expect, it, vi } from "vitest";
import { McpConnectError, McpHttpError, McpSession } from "../client";

// Fetch-mocking discipline borrowed from providers/__tests__/sse.test.ts.

interface CapturedRequest {
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function record(): CapturedRequest[] {
  return [];
}

function jsonResult(id: number, result: unknown, sessionId?: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  });
}

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = frames.map((f) => `event: message\ndata: ${f}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Install a fetch that answers queued responses in order and records posts. */
function serve(responses: Array<Response | ((req: CapturedRequest) => Response)>, posts: CapturedRequest[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const req: CapturedRequest = {
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    posts.push(req);
    const next = responses[i++];
    // Overflow (e.g. an interleaved answer POST) gets a benign 202 — explicit
    // assertions below pin down what each test actually cares about.
    if (!next) return new Response(null, { status: 202 });
    return typeof next === "function" ? next(req) : next;
  });
}

const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: {} };

describe("McpSession", () => {
  it("handshakes, adopts the session id, and rides it on later requests", async () => {
    const posts = record();
    // initialize(1) → initialized notification → tools/list(2)
    serve(
      [
        jsonResult(1, INIT_RESULT, "sess-1"),
        new Response(null, { status: 202 }),
        (req) => {
          expect(req.body).toContain('"method":"tools/list"');
          expect(req.headers["mcp-session-id"]).toBe("sess-1");
          expect(req.headers["mcp-protocol-version"]).toBe("2025-06-18");
          return jsonResult(2, { tools: [{ name: "search", description: "Search." }] }, "sess-1");
        },
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    const tools = await s.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search"]);
    expect(posts[0]!.body).toContain('"method":"initialize"');
    expect(posts[1]!.body).toContain("notifications/initialized");
    vi.restoreAllMocks();
  });

  it("answers an embedded elicitation request while pumping a call's SSE body", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT, "sess-1"),
        new Response(null, { status: 202 }),
        sse([
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: "srv-9",
            method: "elicitation/create",
            params: { message: "allow?" },
          }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "ran after the question" }] },
          }),
        ]),
      ],
      posts,
    );

    const s = new McpSession({
      url: "https://mcp.example",
      onRequest: () => Promise.resolve("decline"),
    });
    await s.initialize();
    const out = await s.callTool("act", {});
    expect(out.isError).toBe(false);
    expect(out.content[0]).toMatchObject({ text: "ran after the question" });
    // The decline went out on its own POST while the call was still streaming.
    await vi.waitFor(() => {
      const answer = posts.find((p) => p.body.includes('"srv-9"'));
      expect(answer?.body).toContain('"result":{"action":"decline"}');
    });
    vi.restoreAllMocks();
  });

  it("answers undeclared server methods with -32601 even when a handler exists", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT, "sess-1"),
        new Response(null, { status: 202 }),
        sse([
          JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "roots/list", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }),
        ]),
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example", onRequest: () => Promise.resolve({}) });
    await s.initialize();
    await s.callTool("x", {});
    await vi.waitFor(() => {
      const answer = posts.find((p) => p.body.includes('"r1"'));
      expect(answer?.body).toContain("-32601");
    });
    vi.restoreAllMocks();
  });

  it("reinitializes exactly once on a 404 expiry and replays the call", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT, "sess-1"),
        new Response(null, { status: 202 }),
        new Response(null, { status: 404 }), // the call: session gone
        jsonResult(1, INIT_RESULT, "sess-2"), // re-handshake
        new Response(null, { status: 202 }),
        (req) => {
          expect(req.headers["mcp-session-id"]).toBe("sess-2");
          return jsonResult(3, { content: [{ type: "text", text: "second try" }] });
        },
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    const out = await s.callTool("t", {});
    expect(out.isError).toBe(false);
    expect(out.content[0]).toMatchObject({ text: "second try" });
    expect(posts.filter((p) => p.body.includes('"method":"initialize"'))).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("treats -32001 like an expiry", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT),
        new Response(null, { status: 202 }),
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "expired" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        jsonResult(1, INIT_RESULT),
        new Response(null, { status: 202 }),
        jsonResult(3, { content: [] }),
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    const out = await s.callTool("t", {});
    expect(out.isError).toBe(false);
    expect(posts.filter((p) => p.body.includes('"method":"initialize"'))).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("fails the call cleanly when the re-handshake also expires", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT),
        new Response(null, { status: 202 }),
        new Response(null, { status: 404 }),
        new Response(null, { status: 404 }),
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    const out = await s.callTool("t", {});
    expect(out.isError).toBe(true);
    expect(String(out.content[0]?.text)).toMatch(/reinitialize failed|404/i);
    vi.restoreAllMocks();
  });

  it("surfaces non-expiry HTTP failures without retry", async () => {
    const posts = record();
    serve(
      [
        jsonResult(1, INIT_RESULT),
        new Response(null, { status: 202 }),
        new Response("server on fire", { status: 500 }),
      ],
      posts,
    );

    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    const out = await s.callTool("t", {});
    expect(out.isError).toBe(true);
    expect(String(out.content[0]?.text)).toContain("HTTP 500");
    expect(posts.filter((p) => p.body.includes("tools/call"))).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("times out a hung server into a tool-error result", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      void init?.headers;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("abort")));
      });
    });

    const s = new McpSession({ url: "https://mcp.example", callTimeoutMs: 20 });
    const out = await s.callTool("t", {});
    expect(out.isError).toBe(true);
    vi.restoreAllMocks();
  });

  it("DELETEs the server-side session on close and swallows failures", async () => {
    const posts = record();
    serve([jsonResult(1, INIT_RESULT, "sess-1"), new Response(null, { status: 202 })], posts);
    const s = new McpSession({ url: "https://mcp.example" });
    await s.initialize();
    vi.restoreAllMocks();
    // Close runs against its own recorder — serve()'s spy is gone by now.
    const deletes: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      deletes.push({
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: "",
      });
      return new Response(null, { status: 405 });
    });
    await s.close();
    expect(deletes[0]?.method).toBe("DELETE");
    expect(deletes[0]?.headers["mcp-session-id"]).toBe("sess-1");
    vi.restoreAllMocks();

    // And a network-failing close still resolves.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gone"));
    const s2 = new McpSession({ url: "https://mcp.example" });
    await s2.initialize().catch(() => {});
    await s2.close();
    vi.restoreAllMocks();
  });

  it("throws typed connect errors from initialize", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    const s = new McpSession({ url: "https://mcp.example" });
    await expect(s.initialize()).rejects.toBeInstanceOf(McpHttpError);
    vi.restoreAllMocks();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("dns fail"));
    const s2 = new McpSession({ url: "https://mcp.example" });
    await expect(s2.initialize()).rejects.toBeInstanceOf(McpConnectError);
    vi.restoreAllMocks();
  });
});
