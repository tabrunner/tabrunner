import type { JevHost } from "@providerkit/core/jev";
import { createWriteQueue, defineItem } from "@/lib/storage";
import type { StorageItem } from "@/lib/storage";
import { ensureProviderCredential } from "@/modules/providers/credential";
import { getProvider } from "@/modules/providers/storage";
import { JEV_HOST_IDS, jevClient, jevEntryId } from "./hosts";
import type { JevConnection } from "./hosts";

/** One saved Jev option in the user's list. */
export interface JevEntry extends JevConnection {
  id: string;
  /** US$ this option has spent through TabRunner — our own count, since no host
   *  but OpenRouter reports a balance. */
  spent: number;
}

/**
 * The saved Jev setup: one or more configured hosts, plus which one is active.
 * Saving a host that checks out turns Jev on and makes that host active; the
 * switch is there for turning Jev off without losing saved hosts.
 */
export interface JevSettings {
  enabled: boolean;
  activeId: string;
  entries: JevEntry[];
}

function isJevHost(v: unknown): v is JevHost {
  return typeof v === "string" && (JEV_HOST_IDS as readonly string[]).includes(v);
}

function normalizeEntry(raw: unknown): JevEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isJevHost(r.host)) return null;
  const model =
    typeof r.model === "string" && r.model
      ? r.model
      : r.host === "opencode"
        ? "jev-1.13-free"
        : undefined;
  const apiKey = typeof r.apiKey === "string" && r.apiKey ? r.apiKey : undefined;
  const accountId = typeof r.accountId === "string" && r.accountId ? r.accountId : undefined;
  const spent = typeof r.spent === "number" && Number.isFinite(r.spent) ? r.spent : 0;
  const id = jevEntryId({ host: r.host, ...(model ? { model } : {}) });
  return {
    id,
    host: r.host,
    ...(apiKey ? { apiKey } : {}),
    ...(accountId ? { accountId } : {}),
    ...(model ? { model } : {}),
    spent,
  };
}

/** Reads both the multi-entry record and the legacy single-host record. */
export function normalizeJevSettings(raw: unknown): JevSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.entries)) {
    const entries = r.entries.map(normalizeEntry).filter((e): e is JevEntry => e !== null);
    if (entries.length === 0) return null;
    const activeId =
      typeof r.activeId === "string" && entries.some((e) => e.id === r.activeId)
        ? r.activeId
        : entries[0]!.id;
    return { enabled: Boolean(r.enabled), activeId, entries };
  }
  const single = normalizeEntry(r);
  if (!single) return null;
  return { enabled: Boolean(r.enabled), activeId: single.id, entries: [single] };
}

/** The active entry in a saved Jev setup. */
export function activeJevEntry(s: JevSettings | null): JevEntry | undefined {
  if (!s) return undefined;
  return s.entries.find((e) => e.id === s.activeId) ?? s.entries[0];
}

const rawJevSettingsItem = defineItem<unknown>("jev", null);

/** Public so the settings UI can read it reactively (useStoredItem). */
export const jevSettingsItem: StorageItem<JevSettings | null> = {
  fallback: null,
  get: async () => normalizeJevSettings(await rawJevSettingsItem.get()),
  set: (v) => rawJevSettingsItem.set(v),
  remove: () => rawJevSettingsItem.remove(),
  watch: (cb) => rawJevSettingsItem.watch((v) => cb(normalizeJevSettings(v))),
};

const serialized = createWriteQueue();

/** Does this Jev option work without an API key? Only OpenCode Zen's free tier does. */
export function isKeylessJev(conn: Pick<JevConnection, "host" | "model">): boolean {
  return conn.host === "opencode" && (conn.model ?? "jev-1.13-free") === "jev-1.13-free";
}

/**
 * Resolves the credential a Jev connection should send right now. When the Jev
 * entry has no key of its own on a shared host (`opencode` or `openrouter`),
 * it reuses the configured provider's key or refreshed OAuth access token.
 */
export async function resolveJevConnection(conn: JevConnection): Promise<JevConnection> {
  const normalized: JevConnection = {
    ...conn,
    ...(conn.host === "opencode" ? { model: conn.model ?? "jev-1.13-free" } : {}),
  };
  if (normalized.apiKey) return normalized;
  if (normalized.host === "opencode" || normalized.host === "openrouter") {
    const stored = await getProvider(normalized.host);
    if (stored && (stored.apiKey || stored.auth)) {
      try {
        const fresh = await ensureProviderCredential(stored);
        if (fresh.apiKey) return { ...normalized, apiKey: fresh.apiKey };
      } catch (err) {
        if (!isKeylessJev(normalized)) throw err;
      }
    }
  }
  return normalized;
}

/** Checks the setup against its host, then saves it as the active Jev option and
 *  turns Jev on. Throws the host's classified error when the check fails. */
export async function saveJevKey(conn: JevConnection, signal?: AbortSignal): Promise<void> {
  const resolved = await resolveJevConnection(conn);
  await jevClient(resolved).checkKey(signal ? { signal } : {});
  await serialized(async () => {
    const prev = await jevSettingsItem.get();
    const entry = normalizeEntry(conn);
    if (!entry) return;
    const existing = prev?.entries.find((e) => e.id === entry.id);
    const sameKey = existing && (existing.apiKey ?? "") === (entry.apiKey ?? "");
    const nextEntry: JevEntry = { ...entry, spent: sameKey ? existing.spent : 0 };
    const entries = prev ? [...prev.entries] : [];
    const idx = entries.findIndex((e) => e.id === nextEntry.id);
    if (idx >= 0) {
      entries[idx] = nextEntry;
    } else {
      entries.push(nextEntry);
    }
    await jevSettingsItem.set({
      enabled: true,
      activeId: nextEntry.id,
      entries,
    });
  });
}

export function setActiveJev(id: string): Promise<void> {
  return serialized(async () => {
    const prev = await jevSettingsItem.get();
    if (!prev || !prev.entries.some((e) => e.id === id)) return;
    await jevSettingsItem.set({ ...prev, activeId: id });
  });
}

export function setJevEnabled(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const prev = await jevSettingsItem.get();
    if (prev) await jevSettingsItem.set({ ...prev, enabled });
  });
}

export function removeJevKey(id?: string): Promise<void> {
  return serialized(async () => {
    if (!id) {
      await jevSettingsItem.remove();
      return;
    }
    const prev = await jevSettingsItem.get();
    if (!prev) return;
    const remaining = prev.entries.filter((e) => e.id !== id);
    if (remaining.length === 0) {
      await jevSettingsItem.remove();
      return;
    }
    const activeId = prev.activeId === id ? remaining[0]!.id : prev.activeId;
    await jevSettingsItem.set({ ...prev, activeId, entries: remaining });
  });
}

export function addJevSpend(cost: number): Promise<void> {
  if (!(cost > 0)) return Promise.resolve();
  return serialized(async () => {
    const prev = await jevSettingsItem.get();
    const active = activeJevEntry(prev);
    if (!prev || !active) return;
    const entries = prev.entries.map((e) =>
      e.id === active.id ? { ...e, spent: e.spent + cost } : e,
    );
    await jevSettingsItem.set({ ...prev, entries });
  });
}

/** The connection a run may use — null when Jev is off or has no usable credential. */
export async function jevForRun(): Promise<JevConnection | null> {
  const s = await jevSettingsItem.get();
  const active = activeJevEntry(s);
  if (!s?.enabled || !active) return null;
  try {
    const resolved = await resolveJevConnection(active);
    if (!resolved.apiKey && !isKeylessJev(resolved)) return null;
    return {
      host: resolved.host,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
    };
  } catch {
    return null;
  }
}
