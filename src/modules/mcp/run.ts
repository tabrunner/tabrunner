import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";
import type { ToolDef } from "@/modules/providers/types";
import { McpSession } from "./client";
import { buildCatalog } from "./schema";
import { listMcpServers, stampServerStatus } from "./store";
import type {
  McpAdvertisedTool,
  McpHandle,
  McpServerConfig,
  McpSessionApi,
  McpToolRef,
} from "./types";

/** What a run gets: model-facing defs appended to its tool array, the handle
 *  that executes them, and one line per server that failed to open (start-run
 *  surfaces each as a warn step — success stays silent, availability is
 *  legible from the tools simply being there). */
interface McpRunSnapshot {
  tools: ToolDef[];
  handle: McpHandle;
  failures: string[];
}

/**
 * The per-run snapshot — the MCP twin of `loadSkillsForRun`. Enabled servers
 * open once, in parallel, while the run is still resolving its tab; a server
 * that fails costs at most one connect timeout, contributes zero tools, stamps
 * its status row and reports one failure line. Nothing throws: the run starts
 * regardless, which is the whole failure-isolation contract.
 */

const log = createLogger("mcp");

const EMPTY_HANDLE: McpHandle = { resolve: () => undefined, close: async () => {} };

export async function loadMcpForRun(signal?: AbortSignal): Promise<McpRunSnapshot> {
  const servers = (await listMcpServers()).filter((s) => s.enabled);
  if (servers.length === 0)
    return { tools: [], handle: EMPTY_HANDLE, failures: [] };

  const opened = await Promise.all(servers.map((cfg) => openServer(cfg, signal)));

  const catalog = buildCatalog(
    opened.flatMap((o) => (o.session ? [{ config: o.config, advertised: o.advertised }] : [])),
  );

  const sessions = new Map<string, McpSessionApi>();
  for (const o of opened) if (o.session) sessions.set(o.config.id, o.session);

  const refs = new Map<string, { session: McpSessionApi; ref: McpToolRef }>();
  for (const { def, ref } of catalog.entries) {
    const session = sessions.get(ref.serverId);
    if (session) refs.set(def.name, { session, ref });
  }

  return {
    tools: catalog.entries.map((e) => e.def),
    handle: {
      resolve: (exposedName) => refs.get(exposedName),
      close: async () => {
        await Promise.allSettled(opened.map((o) => o.session?.close() ?? Promise.resolve()));
      },
    },
    failures: opened.filter((o) => !o.session).map((o) => o.failureLine),
  };
}

/** One-shot connect/list/close for the Settings "Test connection" button.
 *  Stamps nothing — the caller owns the status row once it knows the server id. */
export async function probeServer(
  config: Pick<McpServerConfig, "url" | "headers">,
  signal?: AbortSignal,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const session = new McpSession({ url: config.url, headers: config.headers });
  try {
    await session.initialize();
    const tools = await session.listTools(signal);
    return { ok: true, count: tools.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn("probe failed:", truncate(error));
    return { ok: false, error };
  } finally {
    await session.close();
  }
}

// --- internals ---

interface OpenResult {
  config: McpServerConfig;
  session?: McpSession;
  advertised: McpAdvertisedTool[];
  failureLine: string;
}

async function openServer(config: McpServerConfig, signal?: AbortSignal): Promise<OpenResult> {
  let session: OpenResult["session"];
  try {
    session = new McpSession({ url: config.url, headers: config.headers });
    await session.initialize();
    const advertised = await session.listTools(signal);
    await stampServerStatus(config.id, {
      ok: true,
      detail: i18n.t("mcpOut.status.ok", { count: advertised.length }),
      toolCount: advertised.length,
    });
    log.info("opened", config.name, `${advertised.length} tools`);
    return { config, session, advertised, failureLine: "" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await session?.close();
    await stampServerStatus(config.id, { ok: false, detail: truncate(reason) });
    log.warn("server unavailable:", config.name, truncate(reason));
    return {
      config,
      advertised: [],
      failureLine: i18n.t("mcpOut.run.serverDown", { name: config.name }),
    };
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
