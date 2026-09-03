import { createLogger, truncate } from "@/lib/logger";
import { i18n } from "@/i18n";
import { McpSession } from "./client";
import { buildCatalog } from "./schema";
import { listMcpServers, stampServerStatus } from "./store";
import type {
  McpAdvertisedTool,
  McpHandle,
  McpRunSnapshot,
  McpServerConfig,
  McpSessionApi,
  McpToolRef,
} from "./types";

/**
 * The per-run snapshot — the MCP twin of `loadSkillsForRun`. Enabled servers
 * open once, in parallel, while the run is still resolving its tab; a server
 * that fails costs at most one connect timeout, contributes zero tools, stamps
 * its status row and reports one failure line. Nothing throws: the run starts
 * regardless, which is the whole failure-isolation contract.
 */

const log = createLogger("mcp");

const EMPTY_HANDLE: McpHandle = { resolve: () => undefined, close: async () => {} };

/** Answers a server→client request mid-call. `serverName` says WHO asked, so
 *  the panel can put a face on the question. Injected by start-run — the human
 *  policy lives there; this module stays transport. */
export type McpRequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  serverName: string,
) => Promise<"decline" | Record<string, unknown>>;

export async function loadMcpForRun(
  signal?: AbortSignal,
  onRequest?: McpRequestHandler,
): Promise<McpRunSnapshot> {
  const servers = (await listMcpServers()).filter((s) => s.enabled);
  if (servers.length === 0) return { tools: [], handle: EMPTY_HANDLE, failures: [] };

  const opened = await Promise.all(servers.map((cfg) => openServer(cfg, signal, onRequest)));

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
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const session = new McpSession({ url: config.url, headers: config.headers });
  try {
    await session.initialize();
    const tools = await session.listTools();
    return { ok: true, count: tools.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn("probe failed:", truncate(error, 200));
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

async function openServer(
  config: McpServerConfig,
  signal?: AbortSignal,
  onRequest?: McpRequestHandler,
): Promise<OpenResult> {
  let session: OpenResult["session"];
  try {
    // Bind the server's name into every callback so answers can say who asked.
    const bound = onRequest
      ? (method: string, params: Record<string, unknown> | undefined) =>
          onRequest(method, params, config.name)
      : undefined;
    session = new McpSession({ url: config.url, headers: config.headers, onRequest: bound });
    await session.initialize();
    const advertised = await session.listTools(signal);
    // Display-only mirror: the row repaints whenever the write lands, so it
    // never gates the snapshot these awaits would otherwise serialize behind
    // one storage queue on the run-start path.
    void stampServerStatus(config.id, {
      ok: true,
      detail: i18n.t("mcpOut.status.ok", { count: advertised.length }),
      toolCount: advertised.length,
    });
    log.info("opened", config.name, `${advertised.length} tools`);
    return { config, session, advertised, failureLine: "" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await session?.close();
    void stampServerStatus(config.id, { ok: false, detail: truncate(reason, 200) });
    log.warn("server unavailable:", config.name, truncate(reason, 200));
    return {
      config,
      advertised: [],
      failureLine: i18n.t("mcpOut.run.serverDown", { name: config.name }),
    };
  }
}
