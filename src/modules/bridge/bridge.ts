import { createLogger } from "@/lib/logger";
import { onBoardChanged } from "@/modules/agent/run-queue";
import { getActiveProvider } from "@/modules/providers";
import { providerDisplayName } from "@/modules/providers/presets";
import { credentialStatus, isOAuthProvider } from "@/modules/providers/status";
import type { BridgeActive } from "@/shared/protocol";
import { BridgeClient, BridgeError } from "./client";
import { BRIDGE_PROTOCOL_VERSION } from "./protocol";
import type { BridgeProviderInfo, BridgeRequest, DaemonMessage } from "./protocol";
import { BridgeSocket } from "./ws-client";

const log = createLogger("bridge");
const LEASE_MS = 60_000;

/** Routes the broker's MCP sessions without sharing their status, controls or browser work. */
export class Bridge {
  constructor(private readonly onActivity?: (active: BridgeActive[]) => void) {}

  private socket: BridgeSocket | null = null;
  private readonly clients = new Map<string, BridgeClient>();
  private readonly leases = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly retired = new Set<string>();

  /** Socket and alarm listeners are registered before this turn yields, as MV3 requires. */
  start(): void {
    this.socket = new BridgeSocket(
      (message) => this.onMessage(message),
      () => this.onOpen(),
      () => this.onDisconnect(),
    );
    this.socket.start();
    onBoardChanged((board) => {
      for (const client of this.clients.values()) client.updateQueue(board.queue);
    });
  }

  get activity(): BridgeActive[] {
    return [...this.clients.values()].flatMap((client) =>
      client.activity ? [client.activity] : [],
    );
  }

  stopFromPanel(runId: string): void {
    for (const client of this.clients.values()) client.stopFromPanel(runId);
  }

  private onOpen(): void {
    this.socket?.send({
      type: "hello",
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
  }

  private onDisconnect(): void {
    // A short WS outage is not a stop. Give every owner the full reconnect grace.
    for (const clientId of this.clients.keys()) this.renew(clientId);
  }

  private onMessage(message: DaemonMessage): void {
    switch (message.type) {
      case "ping":
        for (const clientId of message.clientIds) {
          if (validClientId(clientId)) this.renew(clientId);
        }
        this.socket?.send({ type: "pong" });
        break;
      case "request":
        void this.handleRequest(message);
        break;
    }
  }

  private async handleRequest(request: BridgeRequest): Promise<void> {
    const { clientId, requestId, method, params, runId } = request;
    try {
      if (!validClientId(clientId)) {
        throw new BridgeError(
          "invalid-client",
          "This MCP session has no valid client ID. Restart the MCP client, then try again.",
        );
      }
      if (method === "closeClient") {
        await this.closeClient(clientId);
        this.respond(request, { ok: true });
        return;
      }
      if (this.retired.has(clientId)) {
        throw new BridgeError(
          "client-closing",
          "This MCP session is closing. Start a new MCP session, then try again.",
        );
      }
      this.renew(clientId);
      const client = this.client(clientId);
      const result =
        method === "providerInfo"
          ? await providerInfo()
          : await client.command(method, params, runId);
      this.respond(request, result);
    } catch (error) {
      this.socket?.send({
        type: "response",
        clientId,
        requestId,
        ok: false,
        error: {
          code: error instanceof BridgeError ? error.code : "request-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private client(clientId: string): BridgeClient {
    let client = this.clients.get(clientId);
    if (!client) {
      client = new BridgeClient(
        clientId,
        (event) => this.socket?.send(event),
        () => {
          this.onActivity?.(this.activity);
        },
      );
      this.clients.set(clientId, client);
    }
    return client;
  }

  private renew(clientId: string): void {
    if (this.retired.has(clientId)) return;
    const old = this.leases.get(clientId);
    if (old) clearTimeout(old);
    this.leases.set(
      clientId,
      setTimeout(() => {
        this.leases.delete(clientId);
        void this.closeClient(clientId).catch((error: unknown) =>
          log.warn("client cleanup failed", String(error)),
        );
      }, LEASE_MS),
    );
  }

  private closeClient(clientId: string): Promise<void> {
    this.retired.add(clientId);
    const pending = this.closing.get(clientId);
    if (pending) return pending;
    const lease = this.leases.get(clientId);
    if (lease) clearTimeout(lease);
    this.leases.delete(clientId);
    const client = this.clients.get(clientId);
    if (!client) return Promise.resolve();
    const closing = client.close().finally(() => {
      if (this.clients.get(clientId) === client) this.clients.delete(clientId);
      this.closing.delete(clientId);
      this.onActivity?.(this.activity);
    });
    this.closing.set(clientId, closing);
    return closing;
  }

  private respond(request: BridgeRequest, result: unknown): void {
    this.socket?.send({
      type: "response",
      clientId: request.clientId,
      requestId: request.requestId,
      ok: true,
      result,
    });
  }
}

async function providerInfo(): Promise<BridgeProviderInfo> {
  const provider = await getActiveProvider();
  if (!provider) return { name: null, ready: false, auth: null, model: null };
  return {
    name: providerDisplayName(provider),
    ready: credentialStatus(provider) === "connected",
    auth: isOAuthProvider(provider.id) ? "subscription" : "key",
    model: provider.model ?? null,
  };
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
