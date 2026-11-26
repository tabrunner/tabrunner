import { defineItem } from "@/lib/storage";
import { DEFAULT_BRIDGE_PORT } from "./protocol";

/** Time to recover an owner's connection before giving up on its work. */
export const BRIDGE_LEASE_MS = 60_000;

/**
 * Bridge config — off by default: almost nobody runs an MCP client, and an
 * enabled bridge with no daemon listening pays a failed-WebSocket console
 * error every reconcile, which on a fresh install reads as the extension being
 * broken. Chromium logs a refused socket from the network stack — no JS can
 * silence it — so not dialing is the only clean install. MCP users opt in at
 * Settings → MCP; the port starts the small range the extension checks for a broker.
 * The config lives apart from the socket so settings can read and edit it without
 * bundling the WebSocket client.
 */
export const bridgeItem = defineItem<{ enabled: boolean; port: number }>("bridge", {
  enabled: false,
  port: DEFAULT_BRIDGE_PORT,
});

/**
 * Whether the daemon link is up right now, mirrored from the socket by the
 * worker so UI contexts can show it over the storage-watch channel — the
 * socket itself is reachable only in the background.
 */
export const bridgeConnected = defineItem<boolean>("bridgeConnected", false);

/** Each MCP session keeps its own thread through worker suspension and reload. */
export function bridgeThread(clientId: string) {
  return defineItem<string | null>(`bridge-client:${clientId}:conversation`, null);
}

/** Well-known and system ports are never a daemon — userland range only. */
export function validBridgePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65_535;
}
