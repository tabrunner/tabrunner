import { createLogger } from "@/lib/logger";
import { isRecord } from "@/shared/types";
import { BRIDGE_LEASE_MS, bridgeConnected, bridgeItem, validBridgePort } from "./config";
import { BRIDGE_PROTOCOL_VERSION, bridgePorts } from "./protocol";
import type { DaemonMessage, ExtensionMessage } from "./protocol";

const log = createLogger("bridge");
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Outbound WS to the local daemon. The worker cannot listen on a socket,
 * so this is always a client. A 30s alarm reconciles the link and wakes a
 * suspended worker. Register its listener synchronously to receive that wakeup.
 */
export class BridgeSocket {
  private connection: {
    ws: WebSocket;
    preferred: number;
    accepted: boolean;
    close: () => void;
  } | null = null;
  private lastAcceptedPort: number | null = null;
  private reconnectDeadline = 0;
  private outageExplained = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly alarm = "tabrunner-bridge";

  constructor(
    private readonly onMessage: (msg: DaemonMessage) => void,
    private readonly sendHello: () => void,
    private readonly onDisconnect?: () => void,
    private readonly hasActiveWork: () => boolean = () => false,
  ) {}

  start(): void {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === this.alarm) void this.reconcile();
    });
    bridgeItem.watch(() => void this.reconcile());
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    const { enabled, port } = await bridgeItem.get();
    const connection = this.connection;
    if (!enabled) {
      this.cancelReconnect();
      connection?.close();
      if (connection?.accepted) this.beginReconnectGrace();
      await Promise.all([chrome.alarms.clear(this.alarm), bridgeConnected.set(false)]);
      return;
    }
    // Same name replaces, so reconciling never stacks alarms.
    const alarm = chrome.alarms.create(this.alarm, { periodInMinutes: 0.5 });
    if (connection?.accepted) {
      // A live broker owns its sessions. Never switch it out on a settings edit.
      this.send({ type: "pong" });
    } else if (connection?.preferred !== port) {
      this.cancelReconnect();
      connection?.close();
      void bridgeConnected.set(false);
      if (validBridgePort(port)) {
        const ports = bridgePorts(port);
        const last = this.lastAcceptedPort;
        this.dial(
          port,
          last !== null && ports.includes(last)
            ? [last, ...ports.filter((p) => p !== last)]
            : ports,
        );
      }
    }
    await alarm;
  }

  /** Only the hello can go out before a broker confirms the link. */
  send(msg: ExtensionMessage): void {
    const connection = this.connection;
    if (
      !connection ||
      connection.ws.readyState !== WebSocket.OPEN ||
      (!connection.accepted && msg.type !== "hello")
    )
      return;
    try {
      connection.ws.send(JSON.stringify(msg));
    } catch (e) {
      log.debug("ws send failed:", e instanceof Error ? e.message : String(e));
    }
  }

  private dial(preferred: number, ports: number[]): void {
    const [port, ...remaining] = ports;
    if (port !== this.lastAcceptedPort && this.holdingPort()) return;
    if (port === undefined) {
      if (!this.outageExplained) {
        this.outageExplained = true;
        log.info(
          `No compatible MCP broker in the range starting at ws://127.0.0.1:${preferred}. ` +
            `Chromium logs refused WebSocket connections when a port has no listener. ` +
            `The bridge retries every 30s while enabled in Settings → MCP.`,
        );
      }
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    } catch {
      this.dial(preferred, remaining);
      return;
    }
    const close = () => {
      this.connection = null;
      clearTimeout(timer);
      ws.close();
    };
    const connection = { ws, preferred, accepted: false, close };
    const fail = () => {
      if (this.connection !== connection) return;
      close();
      if (connection.accepted) {
        log.debug("bridge ws closed");
        void bridgeConnected.set(false);
        this.beginReconnectGrace();
        this.scheduleReconnect();
      } else {
        this.dial(preferred, remaining);
      }
    };
    const timer = setTimeout(fail, PROBE_TIMEOUT_MS);
    this.connection = connection;

    ws.onopen = () => {
      if (this.connection === connection) this.sendHello();
    };
    ws.onmessage = ({ data }) => {
      if (this.connection !== connection || ws.readyState !== WebSocket.OPEN) return;
      const message = readFrame(data);
      if (!connection.accepted) {
        // v0.18.0 sent a ping after validating hello. Only trust it on the configured port.
        const confirmed =
          message?.type === "ready" || (port === preferred && message?.type === "ping");
        if (!confirmed || (port !== this.lastAcceptedPort && this.holdingPort())) {
          fail();
          return;
        }
        clearTimeout(timer);
        connection.accepted = true;
        this.lastAcceptedPort = port;
        this.reconnectDeadline = 0;
        this.outageExplained = false;
        log.info("bridge connected");
        void bridgeConnected.set(true);
      }
      if (message === null) log.debug("bridge ws bad frame");
      else if (message.type !== "ready") this.onMessage(message);
    };
    ws.onclose = fail;
    ws.onerror = fail;
  }

  private beginReconnectGrace(): void {
    this.reconnectDeadline = Date.now() + BRIDGE_LEASE_MS;
    this.onDisconnect?.();
  }

  /** The previous broker can still own live work. Recheck on the next alarm. */
  private holdingPort(): boolean {
    return Date.now() < this.reconnectDeadline && this.hasActiveWork();
  }

  /** A drop is usually a daemon restart. Retry one scan quickly before the alarm. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile();
    }, 2_000);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function readFrame(data: unknown): DaemonMessage | null {
  if (typeof data !== "string") return null;
  try {
    const message: unknown = JSON.parse(data);
    return isDaemonMessage(message) ? message : null;
  } catch {
    return null;
  }
}

function isDaemonMessage(message: unknown): message is DaemonMessage {
  if (!isRecord(message)) return false;
  switch (message.type) {
    case "ready":
      return message.protocolVersion === BRIDGE_PROTOCOL_VERSION;
    case "ping":
      return (
        Array.isArray(message.clientIds) && message.clientIds.every((id) => typeof id === "string")
      );
    case "request":
      return (
        typeof message.requestId === "string" &&
        typeof message.clientId === "string" &&
        (message.runId === undefined || typeof message.runId === "string") &&
        typeof message.method === "string" &&
        isRecord(message.params)
      );
    default:
      return false;
  }
}
