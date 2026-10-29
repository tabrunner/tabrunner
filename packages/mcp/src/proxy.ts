import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config";
import { discoverBroker } from "./runtime";

/** The SDK owns both MCP hops. Lost calls are failed, never replayed. */
export async function runProxy(): Promise<void> {
  const metadata = await discoverBroker();
  const server = new Server(
    { name: "tabrunner", version: config.version },
    { capabilities: { tools: {} } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(metadata.url), {
    requestInit: { headers: { authorization: `Bearer ${metadata.token}` }, redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  let clientPromise: Promise<Client> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closing = false;
  let pinging = false;

  function client(): Promise<Client> {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const upstream = new Client(server.getClientVersion() ?? { name: "", version: "" });
      await upstream.connect(transport, { timeout: 5_000 });
      if (closing) return upstream;
      pingTimer = setInterval(() => {
        if (pinging || closing) return;
        pinging = true;
        void upstream
          .ping({ timeout: Math.min(config.pingMs, 5_000) })
          .catch(() => {
            console.error(
              "[tabrunner] The shared MCP bridge disconnected. Restart this MCP client. Check the page before repeating an action.",
            );
            void close();
          })
          .finally(() => {
            pinging = false;
          });
      }, config.pingMs);
      return upstream;
    })();
    return clientPromise;
  }

  server.oninitialized = () => {
    void client().catch((error: unknown) => {
      console.error(`[tabrunner] ${error instanceof Error ? error.message : String(error)}`);
      void close();
    });
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
    (await client()).listTools(request.params, { signal: extra.signal }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await (
        await client()
      ).callTool(request.params, undefined, { signal: extra.signal, timeout: 90_000 });
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "The shared MCP bridge did not answer. It may have disconnected after the browser action started. Restart this MCP client, then check get_status or browser_snapshot before repeating an action.",
          },
        ],
      };
    }
  });

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    if (pingTimer) clearInterval(pingTimer);
    try {
      await clientPromise?.catch(() => undefined);
      if (transport.sessionId) await Promise.race([transport.terminateSession(), Bun.sleep(2_000)]);
    } catch {
      // A dead proxy loses its lease. Only its own session is collected.
    }
    await transport.close();
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
