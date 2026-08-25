import { describe, expect, it } from "vitest";
import { MAX_MCP_SERVERS, validMcpUrl } from "../config";
import {
  deleteServer,
  getMcpStatus,
  listMcpServers,
  saveServer,
  setServerEnabled,
  stampServerStatus,
} from "../store";

// Storage stand-in and the en catalog come from src/test-setup.ts.

describe("validMcpUrl", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(validMcpUrl("https://api.aboard.sh/mcp")).toBe(true);
    expect(validMcpUrl("http://127.0.0.1:8931/mcp")).toBe(true);
    expect(validMcpUrl("http://localhost:3000")).toBe(true);
    expect(validMcpUrl("http://[::1]:8931")).toBe(true);
    expect(validMcpUrl("http://mcp.example.com")).toBe(false);
    expect(validMcpUrl("ftp://mcp.example.com")).toBe(false);
    expect(validMcpUrl("not a url")).toBe(false);
  });
});

describe("server registry", () => {
  it("saves, normalizes whitespace, and mints ids and createdAt", async () => {
    const saved = await saveServer({ name: "  Aboard  ", url: "https://api.aboard.sh/mcp" });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.server.name).toBe("Aboard");
    expect(saved.server.id).toBeTruthy();
    expect(saved.server.enabled).toBe(true);

    const edited = await saveServer({
      id: saved.server.id,
      name: "Aboard",
      url: "https://api.aboard.sh/v2",
    });
    expect(edited.ok).toBe(true);
    const all = await listMcpServers();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBe("https://api.aboard.sh/v2");
    // An edit keeps the original creation time.
    expect(all[0]!.createdAt).toBe(saved.server.createdAt);
  });

  it("rejects bad names, bad urls, duplicates (case-insensitive), and the cap", async () => {
    expect((await saveServer({ name: "", url: "https://x.example" })).ok).toBe(false);
    expect((await saveServer({ name: "x".repeat(33), url: "https://x.example" })).ok).toBe(false);
    expect((await saveServer({ name: "ok", url: "http://remote.example" })).ok).toBe(false);

    await saveServer({ name: "first", url: "https://a.example" });
    const dup = await saveServer({ name: "FIRST", url: "https://b.example" });
    expect(dup.ok).toBe(false);

    for (let i = 0; i < MAX_MCP_SERVERS - 1; i++)
      await saveServer({ name: `s${i}`, url: `https://s${i}.example` });
    const over = await saveServer({ name: "overflow", url: "https://over.example" });
    expect(over.ok).toBe(false);
    expect(await listMcpServers()).toHaveLength(MAX_MCP_SERVERS);
  });

  it("toggles servers and reports a miss as false", async () => {
    const saved = await saveServer({ name: "a", url: "https://a.example" });
    if (!saved.ok) throw new Error("expected save");
    expect(await setServerEnabled(saved.server.id, false)).toBe(true);
    expect((await listMcpServers())[0]!.enabled).toBe(false);
    expect(await setServerEnabled("missing", true)).toBe(false);
  });

  it("deletes along with the status stamp", async () => {
    const saved = await saveServer({ name: "a", url: "https://a.example" });
    if (!saved.ok) throw new Error("expected save");
    await stampServerStatus(saved.server.id, { ok: true, detail: "3 tools", toolCount: 3 });
    expect((await getMcpStatus(saved.server.id))?.toolCount).toBe(3);

    expect(await deleteServer(saved.server.id)).toBe(true);
    expect(await deleteServer(saved.server.id)).toBe(false); // already gone
    expect(await getMcpStatus(saved.server.id)).toBeUndefined();
    expect(await listMcpServers()).toHaveLength(0);
  });
});
