import { createWriteQueue, defineItem } from "@/lib/storage";
import { i18n } from "@/i18n";
import { MAX_MCP_SERVERS, mcpServersItem, validMcpUrl } from "./config";
import type { McpServerConfig, McpServerStatus } from "./types";

/**
 * CRUD over the server registry plus the connection-status mirror — the
 * schedule store's shape (validation at save, cap enforced here so no caller
 * carries its own version of the limit) with the bridge's config/status split.
 */

const serialized = createWriteQueue();

const statusItem = defineItem<Record<string, McpServerStatus>>("mcp-status", {});

export function listMcpServers(): Promise<McpServerConfig[]> {
  return mcpServersItem.get();
}

export async function getMcpStatus(id: string): Promise<McpServerStatus | undefined> {
  return (await statusItem.get())[id];
}

/** Stamp one server's last outcome. Runs and probes both land here, which is
 *  what keeps the Settings row honest without a live connection. */
export async function stampServerStatus(
  id: string,
  outcome: { ok: boolean; detail?: string; toolCount?: number },
): Promise<void> {
  await serialized(async () => {
    const all = await statusItem.get();
    await statusItem.set({ ...all, [id]: { ...outcome, checkedAt: Date.now() } });
  });
}

export type SaveResult =
  | { ok: true; server: McpServerConfig }
  | { ok: false; error: string };

const ERRORS = {
  tooMany: "mcpOut.errors.tooMany",
  invalidUrl: "mcpOut.errors.invalidUrl",
  invalidName: "mcpOut.errors.invalidName",
  duplicate: "mcpOut.errors.duplicate",
} as const;

export interface ServerInput {
  /** Absent = create. Present = replace that record, keeping its createdAt. */
  id?: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export function saveServer(input: ServerInput): Promise<SaveResult> {
  return serialized(async (): Promise<SaveResult> => {
    const name = input.name.trim();
    if (!name || name.length > 32) return { ok: false, error: i18n.t(ERRORS.invalidName) };
    if (!validMcpUrl(input.url.trim())) return { ok: false, error: i18n.t(ERRORS.invalidUrl) };

    const list = await mcpServersItem.get();
    const id = input.id ?? crypto.randomUUID();
    const existing = list.findIndex((s) => s.id === id);
    if (existing < 0 && list.length >= MAX_MCP_SERVERS)
      return { ok: false, error: i18n.t(ERRORS.tooMany, { max: MAX_MCP_SERVERS }) };
    // The display name doubles as the token inside every exposed tool name, so
    // two servers that differ only by case would collide there.
    if (list.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase()))
      return { ok: false, error: i18n.t(ERRORS.duplicate) };

    const headers = Object.keys(input.headers ?? {}).length ? input.headers : undefined;
    const server: McpServerConfig = {
      id,
      name,
      url: input.url.trim(),
      ...(headers ? { headers } : {}),
      enabled: input.enabled ?? true,
      createdAt: existing < 0 ? Date.now() : list[existing]!.createdAt,
    };
    await mcpServersItem.set(existing < 0 ? [...list, server] : list.with(existing, server));
    return { ok: true, server };
  });
}

/** Removes a server and its status stamp. False when it was already gone. */
export function deleteServer(id: string): Promise<boolean> {
  return serialized(async () => {
    const list = await mcpServersItem.get();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    await mcpServersItem.set(next);
    const statuses = await statusItem.get();
    if (id in statuses) {
      const rest = { ...statuses };
      delete rest[id];
      await statusItem.set(rest);
    }
    return true;
  });
}

export function setServerEnabled(id: string, enabled: boolean): Promise<boolean> {
  return serialized(async () => {
    const list = await mcpServersItem.get();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return false;
    await mcpServersItem.set(list.with(i, { ...list[i]!, enabled }));
    return true;
  });
}
