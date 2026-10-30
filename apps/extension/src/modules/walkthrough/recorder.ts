import type { ToolCall } from "@/modules/providers/types";
import { isAttached, tabOwner, captureFrame } from "@/modules/browser/cdp-driver";
import { captureVisibleTab } from "@/modules/browser/capture";
import { withMarksHidden } from "@/modules/browser/indicator";
import { createLogger, truncate } from "@/lib/logger";
import { scopeHostOf } from "@/lib/host";
import { DOCUMENTED_TOOLS, isPostAction } from "./caption";
import {
  MAX_FRAMES,
  MAX_RECORDING_BYTES,
  enforceBudget,
  patchRecording,
  putFrame,
  putRecording,
  settleFrame,
} from "./store";
import type { Frame, FrameGap, Recording, RecordingOutcome } from "./types";

const log = createLogger("walkthrough");

/**
 * The capture spine. One recorder per run, created by `startAgentRun` and armed
 * by the `document` tool.
 *
 * It captures with `Page.captureScreenshot` over the CDP session the run
 * already holds — never `Page.startScreencast`. Screencast is driven by the
 * compositor and a hidden tab stops compositing, so it records nothing exactly
 * when TabRunner runs most (an adopted tab the user switched away from, a
 * scheduled run at 3am, a minimized window). `captureScreenshot` forces a frame
 * out of a hidden tab, which makes it the only background-safe recorder there
 * is. The cost is that we get frames per action rather than a continuous
 * stream — which is what a walkthrough wants anyway.
 *
 * Two invariants earn their weight:
 *
 * - **It never attaches the debugger itself.** Chrome's "debugging this
 *   browser" infobar must not appear before the plan gate's yes. With no
 *   session, a frame is an honest gap.
 * - **Every frame is on disk before the next one is taken.** An MV3 worker can
 *   be killed mid-run; buffered frames would die with it. The manifest stays
 *   `recording` until finalize, so a boot sweep can tell an interrupted
 *   recording from a finished one and mark it `partial`.
 */

/**
 * A capture that has not answered in this long is not going to. `sendCommand`
 * has no timeout of its own, so without this a frozen tab would stall the run
 * indefinitely — the debugger simply never calls back.
 */
const CAPTURE_TIMEOUT_MS = 5000;
/**
 * After this many failures in a row, stop trying. Some environments cannot
 * screenshot the driven tab at all (a pre-131 Chrome on a background tab, a
 * discarded tab, a page that refuses); paying the full timeout on every step
 * would silently add minutes to a run and produce a document of placeholders.
 * Declaring it degraded once, up front, is the honest trade.
 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Frames are read at page width in a document — smaller than the model's own. */
const FRAME_QUALITY = 70;

/** Data URL → Blob without `fetch`: available in the worker, no CSP question. */
function decodeJpeg(dataUrl: string): Blob {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: "image/jpeg" });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("capture timed out")), ms)),
  ]);
}

export interface RunRecorder {
  readonly id: string;
  readonly armed: boolean;
  /**
   * Start documenting, optionally under a title the model chose. Actions the
   * run already took are counted, not recovered — the document says so instead
   * of pretending it caught the whole process.
   */
  arm(title?: string): Promise<void>;
  /** Before a tool runs — the origin frame for element actions. */
  beforeAction(call: ToolCall): Promise<void>;
  /** After a tool runs — the destination frame for navigations, and the verdict. */
  afterAction(call: ToolCall, ok: boolean, data: unknown): Promise<void>;
  /** Close the recording and return it, or null if it was never armed. */
  finalize(outcome: RecordingOutcome, summary?: string): Promise<Recording | null>;
}

/**
 * @param onArm fires the first time the model turns documenting on — the REC
 * state everywhere it shows hangs off this, because arming happens mid-run
 * rather than at run start.
 */
export function createRecorder(
  conversationId: string,
  task: string,
  onArm: (() => void) | undefined,
  target: { ownerId: string; tabId: () => number },
): RunRecorder {
  const recording: Recording = {
    id: crypto.randomUUID(),
    conversationId,
    title: truncate(task, 80),
    status: "recording",
    startedAt: Date.now(),
    frames: 0,
    bytes: 0,
    sites: [],
    armedAtStep: 0,
  };
  let armed = false;
  /** Serializes writes and keeps captures from overlapping on one session. */
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;
  /** The frame awaiting its action's verdict — element actions only. */
  let pending: number | null = null;
  let consecutiveFailures = 0;
  /** Documented actions that happened before the model armed us. Disclosed, never hidden. */
  let missed = 0;

  const queue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = chain.then(op, op);
    chain = next.catch(() => {});
    return next;
  };

  /** The visible fallback also returns the captured tab's title and URL. */
  interface Shot {
    dataUrl: string;
    viewport?: { width: number; height: number };
    url?: string;
    title?: string;
  }

  /**
   * The opening frame, taken before the run has attached to anything.
   *
   * `chrome.tabs.captureVisibleTab` needs no debugger session, which is the
   * whole point: the model arms documenting in its first turn, long before any
   * action, and attaching just to take a picture would raise Chrome's
   * "debugging this browser" infobar on a page the plan gate has not been
   * approved for yet. Only the target tab may be captured, and only while it
   * stays active in its own window. A tab switch during capture discards the shot.
   */
  const grabVisible = async (tabId: number): Promise<Shot | FrameGap> => {
    try {
      const targetTab = await chrome.tabs.get(tabId);
      let switched = false;
      const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
        if (info.windowId === targetTab.windowId && info.tabId !== tabId) switched = true;
      };
      chrome.tabs.onActivated.addListener(onActivated);
      try {
        const [before] = await chrome.tabs.query({ active: true, windowId: targetTab.windowId });
        if (before?.id !== tabId || tabOwner(tabId) !== target.ownerId) return "unattached";
        const shot = await withMarksHidden(tabId, () =>
          withTimeout(captureVisibleTab(targetTab.windowId), CAPTURE_TIMEOUT_MS),
        );
        const [after] = await chrome.tabs.query({ active: true, windowId: targetTab.windowId });
        if (
          switched ||
          shot.tabId !== tabId ||
          after?.id !== tabId ||
          tabOwner(tabId) !== target.ownerId
        ) {
          return "unattached";
        }
        return { dataUrl: shot.dataUrl, url: shot.url, title: shot.title };
      } finally {
        chrome.tabs.onActivated.removeListener(onActivated);
      }
    } catch {
      // A restricted page refuses this the same way it refuses everything else.
      return "restricted";
    }
  };

  /** Best-effort snapshot of the driven tab, or the reason there isn't one. */
  const grab = async (tabId: number): Promise<Shot | FrameGap> => {
    if (tabOwner(tabId) !== target.ownerId) return "unattached";
    if (!isAttached(tabId)) return grabVisible(tabId);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "restricted";
    try {
      // The agent's own badge must not be burned into a document the user
      // shares. It cannot be scrubbed off afterwards.
      const shot = await withMarksHidden(tabId, () =>
        withTimeout(captureFrame(tabId, FRAME_QUALITY), CAPTURE_TIMEOUT_MS),
      );
      if (tabOwner(tabId) !== target.ownerId) return "unattached";
      consecutiveFailures = 0;
      return shot;
    } catch (e) {
      consecutiveFailures++;
      log.debug("frame capture failed:", e instanceof Error ? e.message : String(e));
      if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        recording.degraded = true;
        log.info("capture is failing repeatedly — documenting without screens from here");
      }
      return "timeout";
    }
  };

  const noteSite = (url: string): void => {
    // scopeHostOf, not a raw hostname: it strips www and rejects anything that
    // is not http(s), so an internal page can never be listed as a site the
    // reader is told to sign in to.
    const host = scopeHostOf(url);
    if (host && !recording.sites.includes(host)) recording.sites.push(host);
  };

  /** Capture and store one frame. Returns its seq, or null when the caps are hit. */
  const capture = async (tool: string, args: Record<string, unknown>): Promise<number | null> => {
    if (recording.frames >= MAX_FRAMES || recording.bytes >= MAX_RECORDING_BYTES) {
      if (recording.status === "recording") {
        recording.status = "truncated";
        log.info(`recording ${recording.id} hit its cap — truncated at ${recording.frames} frames`);
      }
      return null;
    }
    const tabId = target.tabId();
    const shot = await grab(tabId);
    const captured = typeof shot === "string" ? undefined : shot;
    const info = await chrome.tabs.get(tabId).catch(() => undefined);
    const url = captured?.url ?? info?.url ?? "";
    noteSite(url);

    const mine = seq++;
    const frame: Frame = {
      recordingId: recording.id,
      seq: mine,
      tool,
      args,
      url,
      title: captured?.title ?? info?.title ?? "",
      ts: Date.now(),
    };
    if (!captured) {
      frame.gap = shot as FrameGap;
    } else {
      const blob = decodeJpeg(captured.dataUrl);
      frame.blob = blob;
      // Absent on the no-attach path, which cannot measure the viewport — that
      // frame carries no click anyway, so the marker has nothing to place.
      if (captured.viewport) frame.viewport = captured.viewport;
      recording.bytes += blob.size;
    }
    recording.frames++;
    await putFrame(frame);
    // The manifest trails every frame so a killed worker leaves accurate counts
    // behind — the recovery sweep has no other way to know what landed.
    await putRecording(recording);
    return mine;
  };

  return {
    id: recording.id,
    get armed() {
      return armed;
    },

    arm(title?: string): Promise<void> {
      if (armed) return Promise.resolve();
      armed = true;
      recording.armedAtStep = missed;
      if (title?.trim()) recording.title = truncate(title.trim(), 80);
      onArm?.();
      log.info(`documenting run in conversation ${conversationId} as ${recording.id}`);
      // The opening frame is the page the reader starts on. It doubles as the
      // capture probe: if this environment cannot screenshot the driven tab,
      // the failure counter starts here rather than three steps in.
      return queue(() => capture("", {})).then(() => undefined);
    },

    beforeAction(call: ToolCall): Promise<void> {
      if (!armed || !DOCUMENTED_TOOLS.has(call.name) || isPostAction(call.name)) {
        return Promise.resolve();
      }
      return queue(async () => {
        pending = await capture(call.name, call.args);
      });
    },

    afterAction(call: ToolCall, ok: boolean, data: unknown): Promise<void> {
      if (!DOCUMENTED_TOOLS.has(call.name)) return Promise.resolve();
      if (!armed) {
        // Nothing to capture yet, but the count is what lets the document admit
        // it joined the process late rather than presenting step 4 as step 1.
        if (ok) missed++;
        return Promise.resolve();
      }
      return queue(async () => {
        if (isPostAction(call.name)) {
          // A navigation that failed has no destination worth showing.
          if (ok) await capture(call.name, call.args);
          return;
        }
        const target = pending;
        pending = null;
        if (target === null) return;
        // Where the click landed rides back in the tool's own result — the
        // driver resolved the ref to a point, so nothing here has to guess.
        const point = data as { x?: number; y?: number } | undefined;
        const click =
          call.name === "click" && typeof point?.x === "number" && typeof point?.y === "number"
            ? { x: point.x, y: point.y }
            : undefined;
        await settleFrame(recording.id, target, { ok, ...(click ? { click } : {}) });
      });
    },

    async finalize(outcome: RecordingOutcome, summary?: string): Promise<Recording | null> {
      if (!armed) return null;
      armed = false;
      // The closing frame is the result — captured here, inside the run's
      // teardown, before this owner's browser sessions are released.
      await queue(() => capture("", {}));
      recording.status = recording.status === "truncated" ? "truncated" : "complete";
      recording.endedAt = Date.now();
      recording.outcome = outcome;
      if (summary) recording.summary = summary;
      await patchRecording(recording.id, recording);
      log.info(
        `recording ${recording.id} ${recording.status}: ${recording.frames} frames, ${Math.round(recording.bytes / 1024)}kB`,
      );
      void enforceBudget();
      return recording;
    },
  };
}
