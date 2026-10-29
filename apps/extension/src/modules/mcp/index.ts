/**
 * Public surface of the MCP client half — what the agent loop, start-run and
 * the options page consume. Transport internals stay behind client.ts; the
 * registry CRUD and status mirror come through here too.
 */

export { loadMcpForRun } from "./run";
export { normalizeMcpResult } from "./results";
export { MCP_TOOL_PREFIX } from "./types";
export type { McpHandle, McpRunSnapshot } from "./types";
