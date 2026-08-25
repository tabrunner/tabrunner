import { defineItem } from "@/lib/storage";
import type { McpServerConfig } from "./types";

/**
 * The registry record and its URL rule — deliberately apart from the store's
 * CRUD and the transport, so the options page can validate input without
 * bundling a session (the same split `modules/bridge/config.ts` draws).
 */

/** ponytail: one flat capped array rewritten per write — tens of servers, not
 *  thousands; the schedule store's ceiling, for the same reasons. */
export const MAX_MCP_SERVERS = 20;

export const mcpServersItem = defineItem<McpServerConfig[]>("mcp-servers", []);

/**
 * https anywhere; plain http only for loopback hosts — plenty of local MCP
 * daemons speak Streamable HTTP on 127.0.0.1, and nothing remote should ever
 * ride cleartext.
 */
export function validMcpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "localhost" || host.endsWith(".localhost");
}
