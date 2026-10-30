import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config";
import { discoverBroker, type BrokerMetadata } from "./runtime";

interface Upstream {
  client: Client;
  transport: StreamableHTTPClientTransport;
  metadata: BrokerMetadata;
}

const SESSION_RESET =
  "The previous MCP session was lost. This client has a new session, so earlier task status and controls are no longer available. No browser actions were replayed. Check the browser before starting the task again.";

/** The SDK owns both MCP hops. Lost calls are failed, never replayed. */
export async function runProxy(): Promise<void> {
  const initialMetadata = await discoverBroker();
  const server = new Server(
    { name: "tabrunner", version: config.version },
    { capabilities: { tools: {} } },
  );
  let upstream: Upstream | null = null;
  let connecting: Promise<Upstream> | null = null;
  let connectingTransport: StreamableHTTPClientTransport | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closing = false;
  let pinging = false;
  let needsDiscovery = false;
  let sessionExpired = false;
  let sessionReset = false;

  function failed(current: Upstream, error: unknown): void {
    if (upstream !== current) return;
    needsDiscovery = true;
    sessionExpired ||= error instanceof StreamableHTTPError && error.code === 404;
  }

  function client(): Promise<Upstream> {
    if (closing) return Promise.reject(new Error("This MCP client is closing."));
    if (connecting) return connecting;
    if (upstream && !needsDiscovery) return Promise.resolve(upstream);
    connecting = (async () => {
      const metadata = needsDiscovery ? await discoverBroker() : initialMetadata;
      if (closing) throw new Error("This MCP client is closing.");
      if (
        upstream &&
        !sessionExpired &&
        metadata.url === upstream.metadata.url &&
        metadata.token === upstream.metadata.token
      ) {
        needsDiscovery = false;
        return upstream;
      }
      if (upstream) {
        const previous = upstream;
        upstream = null;
        sessionReset = true;
        await previous.client.close();
      }
      if (closing) throw new Error("This MCP client is closing.");
      const transport = new StreamableHTTPClientTransport(new URL(metadata.url), {
        requestInit: { headers: { authorization: `Bearer ${metadata.token}` }, redirect: "error" },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
      const connected = new Client(server.getClientVersion() ?? { name: "", version: "" });
      connectingTransport = transport;
      try {
        await connected.connect(transport, { timeout: 5_000 });
        if (closing) throw new Error("This MCP client is closing.");
      } catch (error) {
        needsDiscovery = true;
        await transport.close();
        throw error;
      } finally {
        if (connectingTransport === transport) connectingTransport = null;
      }
      upstream = { client: connected, transport, metadata };
      needsDiscovery = false;
      sessionExpired = false;
      return upstream;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function ping(): Promise<void> {
    if (pinging || closing) return;
    pinging = true;
    let current: Upstream | null = null;
    try {
      current = await client();
      if (closing) return;
      await current.client.ping({ timeout: Math.min(config.pingMs, 5_000) });
    } catch (error) {
      if (closing) return;
      if (current) failed(current, error);
      console.error(
        `[tabrunner] ${error instanceof Error ? error.message : String(error)}. The next request will try the shared bridge again. Browser actions are not replayed.`,
      );
    } finally {
      pinging = false;
    }
  }

  server.oninitialized = () => {
    if (closing) return;
    pingTimer = setInterval(() => void ping(), config.pingMs);
    void ping();
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
    (await client()).client.listTools(request.params, { signal: extra.signal }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let current: Upstream;
    try {
      current = await client();
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
    try {
      const result = await current.client.callTool(request.params, undefined, {
        signal: extra.signal,
        timeout: 90_000,
      });
      if (sessionReset && ["health", "get_status"].includes(request.params.name)) {
        return {
          ...result,
          content: [
            { type: "text", text: SESSION_RESET },
            ...(Array.isArray(result.content) ? result.content : []),
          ],
        };
      }
      if (
        upstream === current &&
        !result.isError &&
        ["run", "browser_start", "new_conversation"].includes(request.params.name)
      )
        sessionReset = false;
      return result;
    } catch (error) {
      failed(current, error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "The shared MCP bridge did not answer. It may have disconnected after the browser action started. Call health to reconnect, then check get_status or the browser before repeating an action. No action was replayed.",
          },
        ],
      };
    }
  });

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    if (pingTimer) clearInterval(pingTimer);
    await connectingTransport?.close();
    await connecting?.catch(() => undefined);
    if (upstream) {
      try {
        if (upstream.transport.sessionId)
          await Promise.race([upstream.transport.terminateSession(), Bun.sleep(2_000)]);
      } catch {
        // A dead proxy loses its lease. Only its own session is collected.
      }
      await upstream.client.close();
    }
    await server.close();
  }

  server.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
}
