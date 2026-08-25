import { describe, expect, it, vi } from "vitest";
import { saveServer } from "../store";
import { loadMcpForRun, probeServer } from "../run";

// Storage stand-in and the en catalog come from src/test-setup.ts.

/** Route mocked responses per URL, in order. Notification posts answer
 *  themselves with 202 so they never consume a queued reply. */
function serveByUrl(routes: Record<string, Array<unknown>>) {
  const cursors = new Map<string, number>();
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("notifications/")) return new Response(null, { status: 202 });
    const queue = routes[url] ?? [];
    const i = cursors.get(url) ?? 0;
    cursors.set(url, i + 1);
    const next = queue[i];
    if (next === undefined) return new Response(null, { status: 202 });
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function jsonOk(id: number, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

describe("loadMcpForRun", () => {
  it("opens enabled servers in parallel and namespaces their tools", async () => {
    const saved = await saveServer({ name: "aboard", url: "https://aboard.example" });
    expect(saved.ok).toBe(true);
    serveByUrl({
      "https://aboard.example": [
        jsonOk(1, { protocolVersion: "2025-06-18" }),
        jsonOk(2, {
          tools: [{ name: "search", description: "Search.", inputSchema: { type: "object" } }],
        }),
      ],
    });

    const snap = await loadMcpForRun();
    expect(snap.failures).toEqual([]);
    expect(snap.tools.map((t) => t.name)).toEqual(["mcp__aboard__search"]);
    expect(snap.handle.resolve("mcp__aboard__search")?.ref.toolName).toBe("search");
    expect(snap.handle.resolve("mcp__aboard__nope")).toBeUndefined();
    await snap.handle.close();
    vi.restoreAllMocks();
  });

  it("a dead server costs zero tools, one failure line, and never throws", async () => {
    expect((await saveServer({ name: "live", url: "https://live.example" })).ok).toBe(true);
    expect((await saveServer({ name: "dead", url: "https://dead.example" })).ok).toBe(true);
    serveByUrl({
      "https://live.example": [
        jsonOk(1, { protocolVersion: "2025-06-18" }),
        jsonOk(2, { tools: [{ name: "t1" }] }),
      ],
      // initialize dies at the transport level.
      "https://dead.example": [new Response("down", { status: 500 })],
    });

    const snap = await loadMcpForRun();
    expect(snap.tools.map((t) => t.name)).toEqual(["mcp__live__t1"]);
    expect(snap.failures).toHaveLength(1);
    expect(snap.failures[0]).toContain("dead");
    await snap.handle.close();
    vi.restoreAllMocks();
  });
});

describe("probeServer", () => {
  it("counts tools on success and carries the error text on failure", async () => {
    serveByUrl({
      "https://probe.example": [
        jsonOk(1, { protocolVersion: "2025-06-18" }),
        jsonOk(2, { tools: [{ name: "a" }, { name: "b" }] }),
      ],
    });
    const good = await probeServer({ url: "https://probe.example" });
    expect(good).toEqual({ ok: true, count: 2 });
    vi.restoreAllMocks();

    serveByUrl({ "https://bad.example": [new Response("denied", { status: 401 })] });
    const bad = await probeServer({ url: "https://bad.example" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("401");
    vi.restoreAllMocks();
  });
});
