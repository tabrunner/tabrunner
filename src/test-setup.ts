/**
 * Shared test bootstrap, installed via vitest `setupFiles`. Everything here is
 * set up for you except `fireStorageWatch`, which tests import to simulate a
 * storage write's watch notification (the in-memory store below has no real
 * change notifications).
 *
 * - Minimal chrome surface: modules like cdp-driver register event listeners
 *   at import time — real in the extension, absent under vitest. Individual
 *   tests replace globalThis.chrome with richer stubs as needed.
 * - In-memory chrome.storage.local: one entry per defineItem key (the
 *   keyed-Map shape is what makes per-conversation keys observable). Reset
 *   between tests so every case starts from a clean store.
 * - The en i18n catalog: production initI18n reads storage, tests load it
 *   directly.
 */
import { beforeAll, beforeEach, vi } from "vitest";
import { i18n } from "@/i18n";
import en from "@/i18n/locales/en.json";

if (typeof globalThis.chrome === "undefined") {
  const noop = { addListener: () => {}, removeListener: () => {} };
  (globalThis as Record<string, unknown>).chrome = {
    // The panel asks which tab is active (and watches for it changing) as soon
    // as the composer mounts — no tabs in the stub, so every answer is "none".
    tabs: { onRemoved: noop, onUpdated: noop, onActivated: noop, query: () => Promise.resolve([]) },
    debugger: { onDetach: noop, onEvent: noop },
    // Rendering a panel surface can reach for the version (a bug report carries it).
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
    // Schedules arm and clear alarms as a side effect of storage writes.
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      getAll: () => Promise.resolve([]),
    },
  };
}

const values = new Map<string, unknown>();
const watchers = new Map<string, Array<(v: unknown) => void>>();
vi.mock("wxt/utils/storage", () => ({
  storage: {
    // The batched read path (`defineItem().get()` coalesces a tick's reads into
    // one call) goes through here, so the stub owes the same `?? fallback` rule
    // the real driver applies.
    getItems: (keys: Array<{ key: string; options?: { fallback?: unknown } }>) =>
      Promise.resolve(
        keys.map(({ key, options }) => ({
          key,
          value: values.has(key) ? values.get(key) : (options?.fallback ?? null),
        })),
      ),
    defineItem: <T>(key: string, opts: { fallback: T }) => ({
      getValue: () => Promise.resolve(values.has(key) ? (values.get(key) as T) : opts.fallback),
      setValue: (v: T) => {
        values.set(key, v);
        return Promise.resolve();
      },
      removeValue: () => {
        values.delete(key);
        return Promise.resolve();
      },
      watch: (cb: (v: T) => void) => {
        const list = watchers.get(key) ?? [];
        list.push(cb as (v: unknown) => void);
        watchers.set(key, list);
        return () => {
          watchers.set(
            key,
            list.filter((f) => f !== cb),
          );
        };
      },
    }),
  },
}));

/**
 * Simulate a storage write's watch notification for `key` (the bare defineItem
 * key — the `local:tabrunner:` prefix is added here). Writes the value first,
 * so a callback that reads gets what a real write left behind.
 */
export function fireStorageWatch(key: string, value: unknown): void {
  values.set(`local:tabrunner:${key}`, value);
  for (const cb of watchers.get(`local:tabrunner:${key}`) ?? []) cb(value);
}

beforeAll(async () => {
  await i18n.init({
    resources: { en: { translation: en } },
    lng: "en",
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });
});

beforeEach(() => {
  values.clear();
  watchers.clear();
});
