import { createLogger } from "@/lib/logger";
import { bridgeConnected, bridgeItem } from "./config";
import type { DaemonMessage, ExtensionMessage } from "./protocol";

const log = createLogger("bridge");

/**
 * Outbound WS to the local daemon — the only place WebSocket lives. The worker
 * cannot listen on a socket, so this is always a client; the daemon accepts and
 * makes requests. A 30s alarm (Chrome's minimum period) reconciles the link: it
 * wakes a suspended service worker and doubles as the heartbeat that keeps it
 * from suspending in the first place — mirroring Kimi's reconcile cadence.
 *
 * `start()` is synchronous on purpose: an MV3 worker only receives events whose
 * listeners were registered in the first turn after the script evaluates, so
 * registering the alarm handler behind an `await` would silently forfeit the
 * wake-ups this class exists for. Creating the alarm is an ordinary API call
 * and can wait for the config — which is what lets a disabled bridge cost
 * nothing at all, and a re-enabled one connect without a worker restart.
 */
export class BridgeSocket {
  private ws: WebSocket | null = null;
  /** Set across the async config read so two reconciles can't open two sockets. */
  private connecting = false;
  /**
   * Whether this outage has already been explained. Chromium logs a refused
   * socket from its own network stack — `WebSocket connection to
   * 'ws://127.0.0.1:17836/ws' failed: net::ERR_CONNECTION_REFUSED`, red, and
   * unsilenceable from JS — which on its own reads like the extension is
   * broken rather than like a daemon that simply isn't up yet. So we caption
   * it. Once, though: the alarm retries every 30s forever, and a caption per
   * retry is a console nobody can read. Cleared by a link that lands, so a
   * daemon that goes away later gets its own explanation.
   */
  private outageExplained = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly alarm = "tabrunner-bridge";

  constructor(
    private readonly onMessage: (msg: DaemonMessage) => void,
    private readonly onOpen: () => void,
  ) {}

  start(): void {
    // Both listeners must be registered before the first await — see above.
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === this.alarm) void this.reconcile();
    });
    bridgeItem.watch(() => void this.reconcile());
    void this.reconcile();
  }

  /**
   * The one path that decides whether we should be connected and gets us there.
   * Runs on boot, on every alarm, and the moment the config changes.
   */
  private async reconcile(): Promise<void> {
    const { enabled, port } = await bridgeItem.get();
    if (!enabled) {
      // An alarm firing every 30s for a feature the user switched off is pure
      // battery cost — the bridge that isn't running wakes nothing.
      await chrome.alarms.clear(this.alarm);
      this.ws?.close();
      await bridgeConnected.set(false);
      return;
    }
    // Same name replaces, so reconciling never stacks alarms.
    await chrome.alarms.create(this.alarm, { periodInMinutes: 0.5 });
    // Heartbeat keeps the worker alive; a dead socket gets reconnected.
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "pong" });
    else await this.connect(port);
  }

  /** Best-effort send — a dead socket silently drops it; the alarm retries. */
  send(msg: ExtensionMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      log.debug("ws send failed:", e instanceof Error ? e.message : String(e));
    }
  }

  private async connect(port: number): Promise<void> {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws = ws;
      let established = false;
      ws.onopen = () => {
        established = true;
        this.outageExplained = false;
        log.info("bridge connected");
        void bridgeConnected.set(true);
        this.onOpen();
      };
      ws.onmessage = (e) => {
        try {
          this.onMessage(JSON.parse(String(e.data)) as DaemonMessage);
        } catch {
          log.debug("bridge ws bad frame");
        }
      };
      ws.onclose = () => {
        this.ws = null;
        log.debug("bridge ws closed");
        void bridgeConnected.set(false);
        if (!established && !this.outageExplained) {
          this.outageExplained = true;
          // The caption for Chromium's red line above it. Not a warning: a
          // daemon that isn't up is the normal state of an enabled bridge —
          // it starts when the user's MCP client starts — so this says what
          // the state is and where to change it, at the level of any other
          // lifecycle line.
          log.info(
            `no daemon on ws://127.0.0.1:${port} — the refused-connection error above is ` +
              `Chromium's own, not a failure inside TabRunner. The daemon starts with your MCP ` +
              `client; the bridge keeps dialing every 30s until it does. Settings → MCP has the ` +
              `port and the setup, and the switch that stops the dialing.`,
          );
        }
        // Only a link that actually existed earns the fast retry. A socket that
        // never opened means no daemon is listening — the overwhelmingly common
        // case — and retrying every 2s would hammer a closed port forever and
        // keep the worker awake for a feature nobody is using. Leave that to
        // the 30s alarm.
        if (established) this.scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    } catch {
      // No daemon listening — the alarm reconciles later. Not an error state:
      // the bridge is optional and most users never run the daemon at all.
    } finally {
      this.connecting = false;
    }
  }

  /** A drop is usually a daemon restart — retry once quickly before the alarm. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile();
    }, 2_000);
  }
}
