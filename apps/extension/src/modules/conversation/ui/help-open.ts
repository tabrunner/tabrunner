import { useSyncExternalStore } from "react";
import { createOpenFlag } from "@/lib/open-flag";

/**
 * The help sheet's open state, shared module-level so its three doors — the
 * /help command (slash-commands.ts is not a component), the composer's "?"
 * gesture, and the settings-menu item — all drive the one HelpDialog the
 * entrypoint renders.
 */
const flag = createOpenFlag();

export const setHelpOpen = flag.set;

/** Every door but the dialog's own close goes through here. */
export function openHelp(): void {
  flag.set(true);
}

export function useHelpOpen(): boolean {
  return useSyncExternalStore(flag.subscribe, flag.get);
}
