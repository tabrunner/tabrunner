import { createLogger } from "@/lib/logger";
import type { Frame, LoadedRecording, Recording } from "./types";

const log = createLogger("walkthrough");

/**
 * Recordings live in IndexedDB, not `chrome.storage.local` — the one place in
 * TabRunner that stores binary. Three reasons, in order of force:
 *
 * 1. `conversations.ts` already names this the upgrade path twice ("base64 in
 *    storage.local blows the quota outright… upgrade path is IndexedDB blobs").
 *    A 200-step run is tens of megabytes; base64 would add a third on top.
 * 2. Chrome's IDB backend keeps large Blobs as files rather than inline values,
 *    so a 60 MB recording never round-trips through a JSON string.
 * 3. It is the only store the video encoder can reach. An offscreen document
 *    gets `chrome.runtime` and nothing else of the extension APIs — IndexedDB
 *    is a web API, so it is the one channel that works from there. (Blobs also
 *    cannot cross `runtime.sendMessage`, which is JSON.)
 *
 * Every extension context shares this origin, so the worker writes frames while
 * the panel reads previews and the viewer renders — IDB's transaction model is
 * built for exactly that. The version is never bumped at runtime: a
 * `versionchange` blocked by another context's open connection is a deadlock,
 * and there is nothing here worth risking it for.
 *
 * ponytail: Blobs only, never ArrayBuffers (crbug 342779913 — large inline
 * values fail to read back sporadically). Ceiling is one flat frames store;
 * upgrade path if recordings ever run to thousands is a per-recording database.
 */

const DB_NAME = "tabrunner-walkthroughs";
const DB_VERSION = 1;
const RECORDINGS = "recordings";
const FRAMES = "frames";
/** Frames belonging to one recording — range-scanned to read, delete, and count. */
const BY_RECORDING = "by-recording";

/** Past this a walkthrough has stopped being a document a person reads. */
export const MAX_FRAMES = 300;
/** One recording's image budget. Hit either cap and the recording is `truncated`. */
export const MAX_RECORDING_BYTES = 60 * 1024 * 1024;
/** Every recording together. Oldest complete ones are evicted to stay under it. */
export const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        db.createObjectStore(RECORDINGS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(FRAMES)) {
        const frames = db.createObjectStore(FRAMES, { keyPath: ["recordingId", "seq"] });
        frames.createIndex(BY_RECORDING, "recordingId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  // A failed open must not poison every later call — the next one retries.
  return dbPromise.catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = op(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`indexedDB ${mode} failed`));
      }),
  );
}

// ── Recordings ──────────────────────────────────────────────────────

export async function putRecording(rec: Recording): Promise<void> {
  await run(RECORDINGS, "readwrite", (s) => s.put(rec));
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  return run<Recording | undefined>(RECORDINGS, "readonly", (s) => s.get(id));
}

/** Newest first — the Settings list and the total-bytes line both read this. */
async function listRecordings(): Promise<Recording[]> {
  const all = await run<Recording[]>(RECORDINGS, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Merge fields into a stored manifest. Read-modify-write inside one call rather
 * than one transaction: the recorder is the only writer while a run is live,
 * and the single run slot means there is never a second one.
 */
export async function patchRecording(id: string, patch: Partial<Recording>): Promise<void> {
  const current = await getRecording(id);
  if (!current) return;
  await putRecording({ ...current, ...patch });
}

// ── Frames ──────────────────────────────────────────────────────────

export async function putFrame(frame: Frame): Promise<void> {
  await run(FRAMES, "readwrite", (s) => s.put(frame));
}

/**
 * File the action's outcome onto a frame already on disk. A frame is captured
 * *before* its action runs — that is the whole point, the reader needs the
 * screen with the target still on it — so whether it worked, and where the
 * click landed, can only be known afterwards. Losing this to a crash costs a
 * marker and one dropped retry, never the frame.
 */
export async function settleFrame(
  recordingId: string,
  seq: number,
  settled: { ok: boolean; click?: { x: number; y: number } },
): Promise<void> {
  const frame = await run<Frame | undefined>(FRAMES, "readonly", (s) => s.get([recordingId, seq]));
  if (!frame) return;
  await putFrame({ ...frame, ...settled });
}

/** Every frame of one recording, in capture order. */
export async function listFrames(recordingId: string): Promise<Frame[]> {
  const frames = await run<Frame[]>(FRAMES, "readonly", (s) =>
    s.index(BY_RECORDING).getAll(recordingId),
  );
  return frames.sort((a, b) => a.seq - b.seq);
}

export async function loadRecording(id: string): Promise<LoadedRecording | undefined> {
  const recording = await getRecording(id);
  if (!recording) return undefined;
  return { recording, frames: await listFrames(id) };
}

// ── Deletion & GC ───────────────────────────────────────────────────

async function deleteRecording(id: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([RECORDINGS, FRAMES], "readwrite");
    tx.objectStore(RECORDINGS).delete(id);
    const index = tx.objectStore(FRAMES).index(BY_RECORDING);
    const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      tx.objectStore(FRAMES).delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"));
  });
}

/**
 * A conversation's recordings go when it does. Wired into both places a
 * transcript disappears (`deleteConversation` and the index's LRU eviction) —
 * without it the blobs outlive every reference to them and quietly own the disk.
 */
export async function removeRecordingsFor(conversationId: string): Promise<void> {
  const all = await listRecordings();
  await Promise.all(
    all.filter((r) => r.conversationId === conversationId).map((r) => deleteRecording(r.id)),
  );
}

/**
 * Which recordings to drop to get back under the global cap — oldest first, and
 * never one that is still being written. Pure so the eviction rule is testable
 * without a database.
 */
export function overBudget(recordings: Recording[], limit = MAX_TOTAL_BYTES): string[] {
  let total = recordings.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= limit) return [];
  const evictable = recordings
    .filter((r) => r.status !== "recording")
    .sort((a, b) => a.startedAt - b.startedAt);
  const doomed: string[] = [];
  for (const rec of evictable) {
    if (total <= limit) break;
    doomed.push(rec.id);
    total -= rec.bytes;
  }
  return doomed;
}

/** Enforce the global cap. Best-effort: a failed eviction never fails a run. */
export async function enforceBudget(): Promise<void> {
  try {
    const doomed = overBudget(await listRecordings());
    for (const id of doomed) await deleteRecording(id);
    if (doomed.length > 0) log.info(`evicted ${doomed.length} recording(s) over the storage cap`);
  } catch (e) {
    log.debug("budget sweep skipped:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Boot sweep: a manifest still marked `recording` outlived the worker that was
 * writing it — the run died mid-capture (an MV3 suspension, a browser restart).
 * Its frames are all on disk, so it becomes an honest `partial` rather than a
 * ghost the viewer would render as still in progress.
 */
export async function recoverInterrupted(): Promise<void> {
  try {
    const stale = (await listRecordings()).filter((r) => r.status === "recording");
    for (const rec of stale) {
      await putRecording({ ...rec, status: "partial", endedAt: rec.endedAt ?? Date.now() });
      log.info(`recovered interrupted recording ${rec.id} as partial`);
    }
  } catch (e) {
    log.debug("recovery sweep skipped:", e instanceof Error ? e.message : String(e));
  }
}
