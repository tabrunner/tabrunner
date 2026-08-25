/**
 * The MCP client half — TabRunner dials OUT to remote servers and offers their
 * tools to its own model. (The server half lives in `modules/bridge/` + the
 * daemon: external clients dial IN to drive this browser.)
 *
 * Remote HTTP only. An MV3 worker cannot spawn processes, so stdio servers are
 * out of scope; sessions are lazy — opened for a run, closed with it.
 */

/** Per-server catalog bound before budgets even look at descriptions. */
export const MAX_TOOLS_PER_SERVER = 128;

/** One tool's description cap — claude-code-original's MAX_MCP_DESCRIPTION_LENGTH. */
export const MAX_TOOL_DESC_CHARS = 2048;

/**
 * The whole-catalog description budget across all servers in a run. A tool
 * schema rides every request of every turn, so this — not a system-prompt
 * listing, which would bill the same tokens twice — is where bloat stops.
 */
export const MAX_TOTAL_DESC_CHARS = 12_000;

/** Tool-result text cap before truncation. The loop trims OLD results harder. */
export const MAX_MCP_RESULT_CHARS = 50_000;

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

/** Wire shape of a callTool result, normalized just enough to normalize further. */
export interface McpCallResult {
  isError: boolean;
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
}

/** The session surface tools execute against (lives with client.ts). */
