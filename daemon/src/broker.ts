import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config";
import { BridgeLink } from "./link";
import { createBridgeServer } from "./server";
import { prepareRuntimeDir, publishMetadata, removeMetadata, type BrokerMetadata } from "./runtime";

interface Session {
  clientId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  expiresAt: number;
}

export async function runBroker(): Promise<void> {
  await prepareRuntimeDir();
  const link = new BridgeLink();
  try {
    // The fixed WS bind elects one winner. Losers never touch metadata or listeners.
    link.listen();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return;
    throw error;
  }
  const sessions = new Map<string, Session>();
  const draining = new Set<Promise<void>>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let metadata: BrokerMetadata | null = null;

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (sessions.size || draining.size || stopping) return;
    idleTimer = setTimeout(() => {
      void shutdown();
    }, config.idleMs);
  }

  function closeSession(session: Session): Promise<void> {
    sessions.delete(session.clientId);
    const drained = (async () => {
      const cleanup = link.closeClient(session.clientId);
      await session.server.close().catch((error: unknown) => {
        console.error(
          `[tabrunner] MCP session close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await cleanup;
    })();
    draining.add(drained);
    void drained.finally(() => {
      draining.delete(drained);
      armIdle();
    });
    return drained;
  }

  function respond(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!metadata || stopping)
      return respond(res, 503, "The bridge is shutting down. Reconnect your MCP client.");
    const host = new URL(metadata.url).host;
    if (
      req.headers.host !== host ||
      (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
    )
      return respond(res, 403, "This bridge accepts only local MCP clients.");
    if (req.headers.authorization !== `Bearer ${metadata.token}`)
      return respond(res, 401, "The bridge token is missing or wrong. Reconnect your MCP client.");
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(metadata));
      return;
    }
    if (req.url !== "/mcp") return respond(res, 404, "Not found");
    const sessionId = req.headers["mcp-session-id"];
    if (Array.isArray(sessionId)) return respond(res, 400, "Use one MCP session id.");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session)
        return respond(res, 404, "This MCP session expired. Reconnect your MCP client.");
      if (req.method === "DELETE") {
        // Cleanup owns all of this client, not the global run slot. The DELETE
        // answer does not wait for a disconnected extension to return.
        void closeSession(session);
        return respond(res, 200, "Session closed");
      }
      session.expiresAt = Date.now() + config.leaseMs;
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") return respond(res, 400, "Initialize a new MCP session first.");
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 10 * 1024 * 1024)
        return respond(res, 413, "The MCP request exceeds 10 MB. Send a smaller request.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return respond(res, 400, "The MCP request is not valid JSON.");
    }
    if (!isInitializeRequest(parsed))
      return respond(res, 400, "Initialize a new MCP session first.");
    const clientId = crypto.randomUUID();
    const client = link.createClient(clientId);
    const server = createBridgeServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => clientId,
      enableJsonResponse: true,
    });
    const session = { clientId, server, transport, expiresAt: Date.now() + config.leaseMs };
    sessions.set(clientId, session);
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      if (!transport.sessionId) void closeSession(session);
    } catch (error) {
      void closeSession(session);
      throw error;
    }
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error(
        `[tabrunner] broker request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent)
        respond(
          res,
          500,
          "The local bridge could not handle this request. Reconnect your MCP client and check the page before retrying an action.",
        );
      else res.end();
    });
  });
  const leases = setInterval(
    () => {
      for (const session of sessions.values()) {
        if (session.expiresAt <= Date.now()) void closeSession(session);
      }
    },
    Math.min(config.pingMs, config.leaseMs),
  );

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(leases);
    if (metadata) await removeMetadata(metadata.token);
    for (const session of [...sessions.values()]) void closeSession(session);
    await Promise.all([...draining]);
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await link.close();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("The local MCP HTTP port could not be opened. Restart the client.");
    metadata = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: crypto.randomUUID() + crypto.randomUUID(),
      version: config.version,
      protocolVersion: config.protocolVersion,
      port: config.port,
      pid: process.pid,
    };
    await publishMetadata(metadata);
    armIdle();
    process.once("SIGTERM", () => {
      void shutdown();
    });
    process.once("SIGINT", () => {
      void shutdown();
    });
  } catch (error) {
    clearInterval(leases);
    http.close();
    await link.close();
    throw error;
  }
}
