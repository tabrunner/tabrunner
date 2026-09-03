import type { ToolDef } from "@/modules/providers/types";

/**
 * The MCP client half — TabRunner dials OUT to remote servers and offers their
 * tools to its own model. (The server half lives in `modules/bridge/` + the
 * daemon: external clients dial IN to drive this browser.)
 *
 * Remote HTTP only. An MV3 worker cannot spawn processes, so stdio servers are
 * out of scope; sessions are lazy — opened for a run, closed with it.
 */

/** Every tool a remote server contributes is namespaced under one prefix.
 *  Never parsed back apart — resolution goes through the run's ref map. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Per-server catalog bound before budgets even look at descriptions. */
export const MAX_TOOLS_PER_SERVER = 128;

/** One tool's description cap — claude-code-original's MAX_MCP_DESCRIPTION_LENGTH. */
export const MAX_TOOL_DESC_CHARS = 2048;

/**
 * One tool's serialized input-schema cap, for the same per-turn reason as the
 * description budget: the schema rides every request of every turn. Generous
 * against real schemas (most land under 1KB); anything larger is a server
 * misbehaving, not a catalog worth billing.
 */
export const MAX_TOOL_SCHEMA_CHARS = 4096;

/**
 * The whole-catalog description budget across all servers in a run. A tool
 * schema rides every request of every turn, so this — not a system-prompt
 * listing, which would bill the same tokens twice — is where bloat stops.
 */
export const MAX_TOTAL_DESC_CHARS = 12_000;

/** Tool-result text cap before truncation. The loop trims OLD results harder. */
export const MAX_MCP_RESULT_CHARS = 50_000;

/** Per-result image cap — one call returning dozens of screenshots is a
 *  misbehaving server, and every image rides the wire to the model. */
export const MAX_MCP_RESULT_IMAGES = 4;

/**
 * Exposed-name budget. Anthropic caps tool names at 64 and its OAuth requests
 * prefix every name with "custom_" (`providers/anthropic.ts`), so 64 − 7 − 1
 * separator is what survives the worst wire.
 */
export const MAX_MCP_NAME_CHARS = 56;

/** One configured remote server. Header VALUES are credentials — never logged.
 *  (The registry record shape lives with the store; this is the shared view.) */
export interface McpServerConfig {
  id: string;
  /** Display name AND the token inside exposed tool names — sanitized at use. */
  name: string;
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

/** One tool as the server advertised it — only the fields we keep. */
export interface McpAdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Where an exposed tool name resolves during a run. */
export interface McpToolRef {
  serverId: string;
  serverName: string;
  /** The tool's name ON THE WIRE to the server (never parsed back from the exposed name). */
  toolName: string;
}

/** Last connection outcome per server id — the Settings row's status dot.
 *  Written by runs and probes, read through storage watch; never bundled with
 *  transport code (the bridge's config/status split). */
export interface McpServerStatus {
  ok: boolean;
  /** Human-readable summary, i18n'd at write time — display-only afterwards. */
  detail?: string;
  toolCount?: number;
  checkedAt: number;
}

/** Wire shape of a callTool result, normalized just enough to normalize further. */
export interface McpCallResult {
  isError: boolean;
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
}

/** The session surface tools execute against (McpSession implements this). */
export interface McpSessionApi {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
}

/** Live handle for one run's set of sessions. */
export interface McpHandle {
  resolve(exposedName: string): { session: McpSessionApi; ref: McpToolRef } | undefined;
  close(): Promise<void>;
}

/** What a run gets: model-facing defs appended to its tool array, the handle
 *  that executes them, and one line per server that failed to open (start-run
 *  surfaces each as a neutral step — success stays silent, availability is
 *  legible from the tools simply being there). */
export interface McpRunSnapshot {
  tools: ToolDef[];
  handle: McpHandle;
  failures: string[];
}
