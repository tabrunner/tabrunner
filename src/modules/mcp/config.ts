import { defineItem } from "@/lib/storage";
import type { McpServerConfig } from "./types";

/**
 * The registry record — deliberately apart from the store's CRUD and the
 * transport, so the options page can validate input without bundling a session
 * (the same split `modules/bridge/config.ts` draws). The URL rule itself is
 * `validOutboundUrl` in @/lib/url, shared with the webhooks module.
 */

/** ponytail: one flat capped array rewritten per write — tens of servers, not
 *  thousands; the schedule store's ceiling, for the same reasons. */
export const MAX_MCP_SERVERS = 20;

export const mcpServersItem = defineItem<McpServerConfig[]>("mcp-servers", []);
