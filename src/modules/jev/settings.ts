import { createWriteQueue, defineItem } from "@/lib/storage";
import { checkJevKey } from "./client";
import type { JevConnection } from "./hosts";

/**
 * The saved Jev setup: one host, one key. Saving a key that checks out turns
 * Jev on — nobody pastes a key to leave it idle; the switch is there for
 * turning it off again.
 */
export interface JevSettings extends JevConnection {
  enabled: boolean;
  /** US$ this key has spent through TabRunner — our own count, since no host
   *  but OpenRouter reports a balance. */
  spent: number;
}

/** Public so the settings UI can read it reactively (useStoredItem). */
export const jevSettingsItem = defineItem<JevSettings | null>("jev", null);

const serialized = createWriteQueue();

/** Checks the key against its host, then saves it switched on. Throws the
 *  host's classified error when the key doesn't work. */
export async function saveJevKey(conn: JevConnection, signal?: AbortSignal): Promise<void> {
  await checkJevKey(conn, signal);
  await serialized(async () => {
    const prev = await jevSettingsItem.get();
    // A new key starts a new count; re-saving the same one keeps it.
    const same = prev?.host === conn.host && prev.apiKey === conn.apiKey;
    await jevSettingsItem.set({ ...conn, enabled: true, spent: same ? prev.spent : 0 });
  });
}

export function setJevEnabled(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const prev = await jevSettingsItem.get();
    if (prev) await jevSettingsItem.set({ ...prev, enabled });
  });
}

export function removeJevKey(): Promise<void> {
  return serialized(() => jevSettingsItem.remove());
}

export function addJevSpend(cost: number): Promise<void> {
  if (!(cost > 0)) return Promise.resolve();
  return serialized(async () => {
    const prev = await jevSettingsItem.get();
    if (prev) await jevSettingsItem.set({ ...prev, spent: prev.spent + cost });
  });
}

/** The connection a run may use — null when Jev is off or has no key. */
export async function jevForRun(): Promise<JevConnection | null> {
  const s = await jevSettingsItem.get();
  if (!s?.enabled || !s.apiKey) return null;
  return { host: s.host, apiKey: s.apiKey, ...(s.accountId ? { accountId: s.accountId } : {}) };
}
