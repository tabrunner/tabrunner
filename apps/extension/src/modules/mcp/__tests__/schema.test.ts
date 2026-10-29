import { describe, expect, it } from "vitest";
import { buildCatalog } from "../schema";
import {
  MAX_TOOL_DESC_CHARS,
  MAX_TOOL_SCHEMA_CHARS,
  MAX_TOOLS_PER_SERVER,
  MAX_TOTAL_DESC_CHARS,
  type McpAdvertisedTool,
  type McpServerConfig,
} from "../types";

function server(id: string, name: string): McpServerConfig {
  return { id, name, url: "https://mcp.example", enabled: true, createdAt: 0 };
}

function tool(
  name: string,
  description?: string,
  inputSchema?: Record<string, unknown>,
): McpAdvertisedTool {
  return { name, description, inputSchema };
}

describe("buildCatalog", () => {
  it("namespaces tools and keeps the exposed-name map intact", () => {
    const { servers, entries } = buildCatalog([
      { config: server("s1", "aboard"), advertised: [tool("search", "Search the inbox.")] },
    ]);
    const slice = servers.get("s1")!;
    expect(slice.defs[0]!.name).toBe("mcp__aboard__search");
    expect(slice.refs.get("mcp__aboard__search")).toEqual({
      serverId: "s1",
      serverName: "aboard",
      toolName: "search",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.def.params).toEqual({ type: "object" });
  });

  it("accepts an absent schema as a no-argument object schema, rejects non-object ones", () => {
    const { servers } = buildCatalog([
      {
        config: server("s1", "a"),
        advertised: [tool("noargs"), tool("bad", "x", { type: "string" })],
      },
    ]);
    const slice = servers.get("s1")!;
    expect(slice.defs.map((d) => d.name)).toEqual(["mcp__a__noargs"]);
    expect(slice.rejected).toBe(1);
  });

  it("rejects tools whose serialized schema blows the per-tool ceiling", () => {
    const { servers } = buildCatalog([
      {
        config: server("s1", "a"),
        advertised: [
          tool("fat", "fine", {
            type: "object",
            properties: { x: { type: "string", description: "z".repeat(MAX_TOOL_SCHEMA_CHARS) } },
          }),
          tool("lean", "fine", { type: "object" }),
        ],
      },
    ]);
    const slice = servers.get("s1")!;
    expect(slice.defs.map((d) => d.name)).toEqual(["mcp__a__lean"]);
    expect(slice.rejected).toBe(1);
  });

  it("truncates descriptions at the per-tool cap", () => {
    const { servers } = buildCatalog([
      { config: server("s1", "a"), advertised: [tool("t", "d".repeat(5000))] },
    ]);
    expect(servers.get("s1")!.defs[0]!.description.length).toBe(MAX_TOOL_DESC_CHARS);
  });

  it("drops whole tools deterministically once the global budget runs out", () => {
    // Ten 2000-char descriptions (the per-tool cap keeps each under its own
    // limit) against the global budget: stored order decides who stays.
    expect(MAX_TOTAL_DESC_CHARS).toBe(12_000); // anchors the arithmetic below
    const ten = Array.from({ length: 10 }, (_, i) => tool(`t${i}`, "d".repeat(2000)));
    const { servers } = buildCatalog([
      { config: server("s1", "a"), advertised: ten },
      { config: server("s2", "b"), advertised: [tool("theirs", "tiny")] },
    ]);
    expect(servers.get("s1")!.defs.map((d) => d.name)).toEqual([
      "mcp__a__t0",
      "mcp__a__t1",
      "mcp__a__t2",
      "mcp__a__t3",
      "mcp__a__t4",
      "mcp__a__t5",
    ]);
    expect(servers.get("s1")!.droppedForBudget).toBe(4);
    expect(servers.get("s2")!.droppedForBudget).toBe(1);
  });

  it("caps the per-server catalog at MAX_TOOLS_PER_SERVER", () => {
    const many = Array.from({ length: MAX_TOOLS_PER_SERVER + 10 }, (_, i) => tool(`t${i}`));
    const { servers } = buildCatalog([{ config: server("s1", "a"), advertised: many }]);
    const slice = servers.get("s1")!;
    expect(slice.defs).toHaveLength(MAX_TOOLS_PER_SERVER);
    // The overflow is silent truncation of an already-absurd catalog — not a rejection.
    expect(slice.rejected).toBe(0);
  });

  it("yields wholesale for a later server that sanitizes to the same token", () => {
    const { servers } = buildCatalog([
      { config: server("s1", "Aboard!"), advertised: [tool("x")] },
      { config: server("s2", "Aboard?"), advertised: [tool("y"), tool("z")] },
    ]);
    expect(servers.get("s1")!.defs).toHaveLength(1);
    expect(servers.get("s2")!.defs).toHaveLength(0);
    expect(servers.get("s2")!.rejected).toBe(2);
  });

  it("first server wins on a within-server duplicate name", () => {
    const { servers } = buildCatalog([
      { config: server("s1", "a"), advertised: [tool("dup"), tool("dup")] },
    ]);
    expect(servers.get("s1")!.defs).toHaveLength(1);
    expect(servers.get("s1")!.rejected).toBe(1);
  });
});
