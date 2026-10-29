import type { BridgeActive } from "@/shared/protocol";
import { Bridge } from "./bridge";

let bridge: Bridge | null = null;

/**
 * Called once per worker boot, synchronously — the bridge registers MV3 event
 * listeners, which Chrome only honours in the worker's first evaluation turn.
 *
 * @param onActivity Fired when an external client starts or stops working in
 * the browser — the worker broadcasts it to every open panel.
 */
export function startBridge(onActivity?: (active: BridgeActive[]) => void): Bridge {
  if (bridge) return bridge;
  bridge = new Bridge(onActivity);
  bridge.start();
  return bridge;
}

/** The singleton, for the worker to answer query_run and route the panel's Stop. */
export function getBridge(): Bridge | null {
  return bridge;
}
