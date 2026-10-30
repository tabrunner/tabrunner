import { storage } from "wxt/utils/storage";

/** Our namespace inside wxt's `local:` area — every key this module mints. */
type ItemKey = `local:tabrunner:${string}`;

/**
 * Reads issued in the same tick leave as ONE `chrome.storage.local.get`.
 *
 * Opening the side panel fires about ten of them — theme, locale, providers,
 * the active provider, run mode, the conversation index, the run board, the
 * open conversation, skills, tip state — and each one is its own IPC to the
 * browser process and, on the first open after an idle night, its own cold
 * LevelDB hit. The worker's boot does the same on the other side of the same
 * single-threaded backend, so the two queue behind each other exactly when it
 * is slowest. Coalescing costs one microtask and collapses the lot into a
 * single round trip; a key asked for twice in the tick is read once and shared.
 *
 * Safe because `defineItem` exposes no versioned items: `getItems` applies the
 * same `value ?? fallback` rule `getValue()` does, and there is no migration
 * step to skip.
 */
let pending: Map<ItemKey, unknown> | null = null;
let inFlight: Promise<Record<string, unknown>> | null = null;

function batchedGet<T>(key: ItemKey, fallback: T): Promise<T> {
  const batch = (pending ??= new Map());
  if (!batch.has(key)) batch.set(key, fallback);
  const flush = (inFlight ??= Promise.resolve().then(() => {
    // Cleared before the read starts, so anything asked for after this point
    // opens the next batch instead of joining one already on the wire.
    pending = null;
    inFlight = null;
    return storage
      .getItems([...batch].map(([key, fallback]) => ({ key, options: { fallback } })))
      .then((rows) => Object.fromEntries(rows.map((r) => [r.key, r.value])));
  }));
  return flush.then((values) => values[key] as T);
}

/** Typed, namespaced storage item — what `defineItem` returns. */
export interface StorageItem<T> {
  /** The default value, exposed so UI can seed state without a second literal. */
  fallback: T;
  get: () => Promise<T>;
  set: (v: T) => Promise<void>;
  remove: () => Promise<void>;
  watch: (cb: (newVal: T) => void) => () => void;
}

/**
 * Thin wrapper around wxt storage that gives us typed, namespace-prefixed keys.
 * Each domain module defines its own items using this helper.
 */
export function defineItem<T>(key: string, fallback: T): StorageItem<T> {
  const fullKey: ItemKey = `local:tabrunner:${key}`;
  const item = storage.defineItem<T>(fullKey, { fallback });
  return {
    fallback,
    get: () => batchedGet(fullKey, fallback),
    set: (v: T) => item.setValue(v),
    remove: () => item.removeValue(),
    watch: (cb: (newVal: T) => void) => item.watch(cb),
  };
}

/**
 * Serializes read-modify-write cycles on a `defineItem` record whose writers
 * race (panel, worker, dialogs) — each store makes one queue and funnels every
 * write through it. The chain survives a failed write: the failure is
 * swallowed here, the caller still sees their own rejection.
 */
export function createWriteQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (op) => {
    const next = chain.then(op, op);
    chain = next.catch(() => {});
    return next;
  };
}
