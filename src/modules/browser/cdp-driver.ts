import type { TabId } from "@/shared/types";
import { i18n } from "@/i18n";
import { refreshAgentIndicator } from "./indicator";
import { startInspecting } from "./inspect";

/**
 * CDP driver — manages chrome.debugger attach/detach and dispatches trusted input events.
 *
 * chrome.debugger provides trusted (isTrusted=true) events — the whole reason
 * we use CDP instead of synthetic JS events. Real clicks and key presses that
 * frameworks (React, Vue) and SPAs can't distinguish from human input.
 */

const tabOwners = new Map<TabId, string>();
const attachedTabs = new Map<TabId, string>();
const pendingAttaches = new Map<TabId, { ownerId: string; promise: Promise<void> }>();
const releasingOwners = new Map<string, Promise<void>>();

/** Runs and direct sessions share one exclusive claim, including before attach. */
export function claimTab(ownerId: string, tabId: TabId): void {
  const owner = tabOwners.get(tabId);
  if ((owner !== undefined && owner !== ownerId) || releasingOwners.has(ownerId)) {
    throw new Error(i18n.t("errors.tabInUse", { tabId }));
  }
  tabOwners.set(tabId, ownerId);
}

export function tabOwner(tabId: TabId): string | undefined {
  return tabOwners.get(tabId);
}

export function isAttached(tabId: TabId): boolean {
  return attachedTabs.has(tabId);
}

let wired = false;

/**
 * The session's listeners, registered on the first attach rather than at module
 * scope — see startInspecting, which this brings up with them and which carries
 * the whole reason. Equivalent by construction: everything they touch (the
 * attached set, the capture rings) is empty until something attaches, so there
 * is nothing for them to have missed.
 */
function wireSession(): void {
  if (wired) return;
  wired = true;
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
  });
  startInspecting();
}

export class DebuggerConflictError extends Error {
  constructor(tabId: TabId) {
    super(
      `Cannot attach debugger to tab ${tabId}. DevTools may be open on this tab, ` +
        `or another extension is using chrome.debugger. Close DevTools and try again.`,
    );
    this.name = "DebuggerConflictError";
  }
}

export class RestrictedUrlError extends Error {
  constructor(tabId: TabId) {
    super(
      `Cannot use debugger on tab ${tabId}. Chrome blocks debugger on chrome:// pages, ` +
        `the Web Store, and other restricted URLs. Navigate to a regular page first.`,
    );
    this.name = "RestrictedUrlError";
  }
}

async function attach(ownerId: string, tabId: TabId): Promise<void> {
  wireSession();
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.set(tabId, ownerId);
    // Feed the run's network/console capture (inspect.ts) from the attach on —
    // by the time the model looks, the failing request is already in the log.
    await send(tabId, "Network.enable");
    await send(tabId, "Runtime.enable");
    // A tab nobody can see (in the background, under another window, minimized)
    // is hidden to Chrome too, and a hidden page holds mouse presses, keys and
    // the wheel in a queue until someone shows it: every action answers ok and
    // nothing happens. Focus emulation makes the page behave as visible and
    // focused, so the work lands without moving the user's screen. Puppeteer
    // does the same for each page it drives. It ends with the attach.
    await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Another debugger is already attached")) {
      throw new DebuggerConflictError(tabId);
    }
    if (msg.includes("'chrome://' URL") || msg.includes("Cannot attach")) {
      throw new RestrictedUrlError(tabId);
    }
    throw e;
  }
}

async function send(
  tabId: TabId,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!isAttached(tabId)) throw new Error(i18n.t("errors.noTabAttached"));
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function ensureAttached(ownerId: string, tabId: TabId): Promise<void> {
  claimTab(ownerId, tabId);
  const pending = pendingAttaches.get(tabId);
  if (pending) return pending.promise;
  if (isAttached(tabId)) return;
  const promise = attach(ownerId, tabId).finally(() => pendingAttaches.delete(tabId));
  pendingAttaches.set(tabId, { ownerId, promise });
  return promise;
}

/** Drain this owner's pending attaches before detaching only its sessions. */
export function releaseBrowserOwner(ownerId: string): Promise<void> {
  const releasing = releasingOwners.get(ownerId);
  if (releasing) return releasing;
  const release = (async () => {
    await Promise.allSettled(
      [...pendingAttaches.values()]
        .filter((pending) => pending.ownerId === ownerId)
        .map((pending) => pending.promise),
    );
    await Promise.all(
      [...attachedTabs]
        .filter(([, owner]) => owner === ownerId)
        .map(async ([tabId]) => {
          try {
            await chrome.debugger.detach({ tabId });
          } catch {
            // Already closed or cancelled. Continue releasing this owner's tabs.
          }
          attachedTabs.delete(tabId);
        }),
    );
  })().finally(() => {
    for (const [tabId, owner] of tabOwners) {
      if (owner === ownerId) tabOwners.delete(tabId);
    }
    releasingOwners.delete(ownerId);
  });
  releasingOwners.set(ownerId, release);
  return release;
}

/** Click at coordinates via trusted CDP mouse events. */
export async function clickAt(tabId: TabId, x: number, y: number): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

let platformModifier: number | null = null;

/** Cmd on macOS, Ctrl everywhere else — what "Mod" and select-all both mean. */
async function getPlatformModifier(): Promise<number> {
  if (platformModifier === null) {
    const info = await chrome.runtime.getPlatformInfo();
    platformModifier = info.os === "mac" ? META : CTRL;
  }
  return platformModifier;
}

/** Test seam: the OS lookup is deliberately cached — this resets it. */
export function resetPlatformModifierForTest(): void {
  platformModifier = null;
}

/** Type text via CDP insertText (trusted input). Clears existing field first. */
export async function typeText(tabId: TabId, text: string): Promise<void> {
  const mod = await getPlatformModifier();
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: mod,
  });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: mod,
  });
  await send(tabId, "Input.insertText", { text });
}

/** Append text without clearing (for contenteditable or partial input). */
export async function insertText(tabId: TabId, text: string): Promise<void> {
  await send(tabId, "Input.insertText", { text });
}

/** A key name resolved to its CDP event fields. */
interface KeySpec {
  key: string;
  code: string;
  vkc: number;
  text?: string;
}

/** Press a key (Enter, Tab, Escape, etc.) via CDP key events. */
const KEY_MAP: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", vkc: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", vkc: 27 },
  tab: { key: "Tab", code: "Tab", vkc: 9, text: "\t" },
  backspace: { key: "Backspace", code: "Backspace", vkc: 8 },
  delete: { key: "Delete", code: "Delete", vkc: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vkc: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vkc: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vkc: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vkc: 39 },
  space: { key: " ", code: "Space", vkc: 32, text: " " },
};

/** The named keys. The model-facing press_key description is built from this
 *  list, so what the model is told and what the driver accepts can't drift. */
export const SUPPORTED_KEYS = Object.keys(KEY_MAP);

/** What the model may name as a modifier. "Mod" spares it the platform guess. */
export const SUPPORTED_MODIFIERS = ["Mod", "Control", "Alt", "Shift", "Meta"];

const MODIFIER_BITS: Record<string, number> = {
  alt: ALT,
  option: ALT,
  control: CTRL,
  ctrl: CTRL,
  meta: META,
  cmd: META,
  command: META,
  shift: SHIFT,
};

/**
 * A key name resolved to its CDP event fields: one of KEY_MAP's names, or any
 * single character — the character case is what makes chords like Mod+a work
 * without listing all 36 alphanumerics in the schema.
 */
export function resolveKey(key: string): KeySpec {
  const named = KEY_MAP[key.toLowerCase()];
  if (named) return named;
  const chars = [...key];
  const ch = chars[0];
  if (chars.length === 1 && ch) {
    const upper = ch.toUpperCase();
    // A code only exists for keys that have a physical one; leaving it empty
    // for punctuation is better than inventing a wrong `Key;`.
    const code = /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : "";
    return { key: ch, code, vkc: upper.charCodeAt(0), text: ch };
  }
  throw new Error(i18n.t("errors.unsupportedKey", { key, supported: SUPPORTED_KEYS.join(", ") }));
}

/** The bitmask for a list of model-supplied modifier names. */
export async function resolveModifiers(modifiers: string[]): Promise<number> {
  let bits = 0;
  for (const name of modifiers) {
    const key = name.trim().toLowerCase();
    const bit = key === "mod" ? await getPlatformModifier() : MODIFIER_BITS[key];
    if (bit === undefined) {
      throw new Error(
        i18n.t("errors.unsupportedModifier", {
          modifier: name,
          supported: SUPPORTED_MODIFIERS.join(", "),
        }),
      );
    }
    bits |= bit;
  }
  return bits;
}

export async function pressKey(tabId: TabId, key: string, modifiers: string[] = []): Promise<void> {
  const spec = resolveKey(key);
  const bits = await resolveModifiers(modifiers);
  const shifted = (bits & SHIFT) !== 0;
  // A chord with Ctrl/Alt/Cmd is a shortcut, not typing: sending `text` with
  // one held makes Chrome insert the character instead of firing the
  // accelerator, so Mod+a would type "a" over the selection it meant to make.
  // Shift alone IS typing — it just uppercases. The modifier keys themselves
  // are never dispatched as their own events; the bitmask is what sets
  // event.metaKey/ctrlKey, which is what pages actually read (typeText's
  // select-all has run this way since day one).
  const accelerated = (bits & ~SHIFT) !== 0;
  const text = accelerated ? undefined : shifted && spec.text ? spec.text.toUpperCase() : spec.text;
  const event = {
    key: shifted && spec.key.length === 1 ? spec.key.toUpperCase() : spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vkc,
    modifiers: bits,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...event,
    ...(text ? { text } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

/** Scroll the page by relative amounts. */
export async function scroll(tabId: TabId, deltaX: number, deltaY: number): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 0,
    y: 0,
    deltaX,
    deltaY,
    modifiers: 0,
    pointerType: "mouse",
  });
}

/**
 * Capture the visible viewport as a `data:` URL, ready to hand to a model.
 *
 * JPEG, not PNG: a screenshot goes into the next request body, and PNG runs
 * several times larger for no readability gain at q80 — on a slow uplink that
 * difference is seconds per step.
 */
export async function screenshot(tabId: TabId, quality = 80): Promise<string> {
  const result = (await send(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality,
  })) as { data: string };
  return `data:image/jpeg;base64,${result.data}`;
}

/**
 * A screenshot plus the CSS viewport it was taken of — what a walkthrough needs
 * to place a click marker on the image later. The click arrives in CSS pixels
 * and the JPEG is in device pixels, so the viewport size is the only thing that
 * relates the two.
 *
 * Deliberately attaches nothing: with no session this throws, and the recorder
 * turns that into an honest gap rather than raising Chrome's debugging infobar
 * on a page the user never approved touching.
 */
export async function captureFrame(
  tabId: TabId,
  quality: number,
): Promise<{ dataUrl: string; viewport: { width: number; height: number } }> {
  const [dataUrl, metrics] = await Promise.all([
    screenshot(tabId, quality),
    send(tabId, "Page.getLayoutMetrics") as Promise<{
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
    }>,
  ]);
  const vp = metrics.cssLayoutViewport;
  return {
    dataUrl,
    viewport: { width: vp?.clientWidth ?? 0, height: vp?.clientHeight ?? 0 },
  };
}

/** A runaway page script gets this long before CDP terminates the evaluation. */
const EVAL_TIMEOUT_MS = 30_000;

interface EvalResponse {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/**
 * Run JavaScript in the page's main world — the model's escape hatch when the
 * tree and trusted input can't do the job. CDP rather than executeScript:
 * page CSP does not apply to debugger evaluation (a string eval injected into
 * the MAIN world dies on any strict script-src page), awaitPromise and
 * replMode come free, and the debugger is already attached for trusted input.
 */
export async function evaluateRaw(tabId: TabId, expression: string): Promise<unknown> {
  const attempt = (expr: string, replMode: boolean) =>
    send(tabId, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      replMode,
      // What the DevTools console grants: clicks and popups the code triggers
      // behave as if the user had acted.
      userGesture: true,
      timeout: EVAL_TIMEOUT_MS,
    }) as Promise<EvalResponse>;

  let r = await attempt(expression, true);
  // Models write statements with a top-level `return`, which REPL mode
  // rejects — rerun wrapped as an async IIFE, the console's own fallback.
  if (r.exceptionDetails && /Illegal return statement/.test(r.exceptionDetails.text)) {
    r = await attempt(`(async () => {\n${expression}\n})()`, false);
  }
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  const { result } = r;
  if (result.value !== undefined) return result.value;
  if (result.type === "undefined") return null;
  // returnByValue drops what JSON can't carry (a DOM node, a function) — the
  // description ("div.cart-summary") tells the model to serialize it in-page.
  return result.description ?? null;
}

/** Navigate the tab to a URL via chrome.tabs (not CDP — works pre-attach). */
export async function navigateToUrl(tabId: TabId, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  // The new document wiped the badge — put it back before the agent acts here.
  await refreshAgentIndicator(tabId);
}

/** Back one entry in the tab's own history — the way out of a dead end. */
export async function goBack(tabId: TabId): Promise<void> {
  try {
    await chrome.tabs.goBack(tabId);
  } catch (e) {
    // Chrome's own message for an empty history reads as a forward-navigation
    // error ("Cannot find a next page in history"), which sends the model
    // looking for the wrong problem.
    throw new Error(i18n.t("errors.noHistoryBack"), { cause: e });
  }
  await waitForLoad(tabId);
  await refreshAgentIndicator(tabId);
}

/**
 * How long to watch for a load starting after an action. Long enough that a
 * click's navigation has committed, short enough to stay cheap on the clicks
 * that navigate nowhere — which is most of them.
 */
const SETTLE_WATCH_MS = 400;

/**
 * Watch briefly for a load starting after an action, and ride it out if one
 * does. Reports whether the page went anywhere.
 *
 * Only worth calling between a turn's tool calls: those run back-to-back with
 * no model latency between them, so a click that navigates hands the call
 * behind it a page still assembling. A turn's last call needs none of this —
 * the round trip is settle enough.
 *
 * ponytail: a fixed watch window, not network-idle or a DOM-settle heuristic.
 * The ceiling is a load that starts after the window looks like no load at all;
 * the ref census in the loop is what catches those. Upgrade path is CDP's
 * Page.frameStartedLoading, which would cost the attach this deliberately avoids.
 */
export async function settleIfLoading(tabId: TabId, watchMs = SETTLE_WATCH_MS): Promise<boolean> {
  const started = await new Promise<boolean>((resolve) => {
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "loading") finish(true);
    };
    const timer = setTimeout(() => finish(false), watchMs);
    const finish = (loading: boolean) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loading);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // The action's own promise may settle after the load is already in flight.
    // A tab that died under the batch answers `undefined` here, with lastError
    // set — reading it is what keeps Chrome from logging it as unchecked, and
    // there is nothing left to wait for either way. The call behind this one is
    // where a dead tab gets reported properly.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) finish(false);
      else if (tab.status === "loading") finish(true);
    });
  });
  if (!started) return false;
  // A load that never finishes is not this call's to report — the action landed,
  // and the ref lookup behind it is what fails loudly.
  await waitForLoad(tabId).catch(() => {});
  return true;
}

/**
 * Resolves when the tab's page has finished loading, and rejects rather than
 * holding on when it never will: a tab closed under the wait can no longer
 * reach "complete", so without `onRemoved` the caller waits the full timeout on
 * a page that stopped existing. The mid-batch settle is what made that ordinary
 * — a click can close its own tab, and the batch behind it should hear about it
 * in milliseconds, not in half a minute.
 */
export function waitForLoad(tabId: TabId, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (tab: chrome.tabs.Tab) =>
      tab.status === "complete" && !!tab.url && tab.url !== "about:blank";

    // One exit for all four endings — the listeners always come back off.
    const done = (err?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => done(new Error(i18n.t("errors.pageLoadTimeout", { seconds: timeoutMs / 1000 }))),
      timeoutMs,
    );
    const listener = (id: number, _info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && check(tab)) done();
    };
    const removed = (id: number) => {
      if (id === tabId) done(new Error(i18n.t("errors.tabClosedWhileLoading")));
    };

    // Listening before the lookup, so a load that completes between the two is
    // not missed — `done` removes both listeners on every path anyway.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    // A tab that is already gone answers `undefined` with lastError set, which
    // the status check would throw on. Reading it names the failure and keeps
    // Chrome from logging it as unchecked.
    chrome.tabs.get(tabId, (tab) => {
      if (!tab) done(new Error(i18n.t("errors.tabGone")));
      else if (check(tab)) done();
    });
  });
}
