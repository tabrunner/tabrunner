import type { TabId } from "@/shared/types";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";
import {
  WIDGET_HOST_ID,
  drivenTabs,
  noteReceipt,
  paintWidget,
  removeWidget,
  settleState,
  type WidgetState,
} from "./status-widget";

const log = createLogger("indicator");
const FAVICON_LINK_ID = "tabrunner-agent-favicon";
/** The link that hands the favicon back to the page when the run lets go. */
const RESTORE_LINK_ID = "tabrunner-agent-favicon-restore";
/** The one on-page mark — the pill both lifecycles paint (see status-widget.ts). */
const MARK_HOST_IDS = [WIDGET_HOST_ID];

/**
 * The driven half of the on-page mark — the lifecycle for the tab an agent is
 * driving (the pill itself, its states and its Hide button live in
 * status-widget.ts; this module owns what only the driven tab needs):
 *
 * - the favicon dot, because once the user switches to another tab the pill is
 *   invisible and the strip is all they have left. A still dot, not a blink:
 *   motion in a 16px favicon reads as a broken page.
 *
 * One tab per run, and runs move one at a time (switch_tab hides before it
 * shows), so at most one tab per run is marked. Marks are repainted after any
 * load that wipes them, including click-triggered navigations.
 *
 * The favicon dot breathes — a heartbeat saying "working", not just "here".
 * The frames are pushed from this worker, never by a page-side timer: Chrome
 * throttles hidden-tab timers into silence, and hidden is exactly when the
 * strip signal matters. The worker stays awake for the run (the panel's Port
 * heartbeat sees to that).
 *
 * When a run parks on the user (a plan to approve, an ask_user question), the
 * dot does not vanish — that is the moment the agent needs you most. It settles
 * into a still amber "?": working became waiting-on-you. Still, not pulsing —
 * the pulse is the "alive" language, and the agent is now blocked on the human.
 * The badge stays too (the pill's waiting state), saying so and offering the
 * way back; it used to be pulled here, which meant a run that re-planned
 * mid-flight silently stripped the page of every sign TabRunner was on it.
 * The wait clears when the next run starts (an answer is a run) or the tab is
 * otherwise unmarked.
 *
 * When the run finishes, the pill settles into the receipt (✓/✗, self-clearing)
 * instead of vanishing — see settleAgentIndicator.
 *
 * Best-effort by design: restricted pages (chrome://, the Web Store), a PDF
 * viewer, a `file://` url without file access and a hostile CSP all reject
 * injection, and a run must not fail because its marks could not be drawn.
 * That is survivable only because it is not the last line: the run's green tab
 * group and the toolbar badge (action-badge.ts) need no injection at all.
 */

/** Waiting and recording belong to a tab, never to another run's marks. */
const waitingTabs = new Set<TabId>();
const documentingTabs = new Set<TabId>();
/** Order paints per tab and skip queued states that a newer update replaced. */
const markUpdates = new Map<TabId, Promise<void>>();

function updateMarks(
  tabId: TabId,
  update: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  const previous = markUpdates.get(tabId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const isCurrent = () => markUpdates.get(tabId) === next;
      if (isCurrent()) await update(isCurrent);
    });
  markUpdates.set(tabId, next);
  return next.finally(() => {
    if (markUpdates.get(tabId) === next) markUpdates.delete(tabId);
  });
}

/** Solid amber dot — the favicon the driven tab shows in the tab strip. */
const FAVICON_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23fbbf24'/%3E%3C/svg%3E";
/** The same dot at a quarter opacity — the heartbeat's low beat. */
const FAVICON_DIM_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23fbbf24' fill-opacity='0.25'/%3E%3C/svg%3E";
/** The dot with a knocked-out "?" — the run ended on a question for the user. */
const FAVICON_WAITING_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23fbbf24'/%3E%3Ctext x='8' y='11.3' font-size='9.5' font-weight='700' text-anchor='middle' fill='%23451a03' font-family='ui-sans-serif,system-ui,sans-serif'%3E%3F%3C/text%3E%3C/svg%3E";
const FAVICON_FRAMES = [FAVICON_DATA_URL, FAVICON_DIM_URL];
/** Two beats make the badge's 1.4s breath — one motion language for "alive". */
const PULSE_BEAT_MS = 700;
/** One heartbeat per driven tab; started on show, stopped on hide. */
const pulseTimers = new Map<TabId, ReturnType<typeof setInterval>>();

/**
 * Runs in the page: the strip half only — the pill is the shared paintWidget.
 * The link is appended last, so it wins over the page's own; a page that
 * manages its favicon dynamically (unread counters) can still out-vote it
 * mid-run — we don't fight the page, the pill keeps carrying the signal.
 */
export function paintFavicon(linkId: string, faviconUrl: string, restoreId: string): void {
  document.getElementById(linkId)?.remove();
  document.getElementById(restoreId)?.remove();

  const link = document.createElement("link");
  link.id = linkId;
  link.rel = "icon";
  link.href = faviconUrl;
  (document.head ?? document.documentElement).appendChild(link);
}

/**
 * Runs in the page: hand the favicon back. Removing our link alone is not
 * enough — Chrome keeps showing the last-set favicon until an icon link
 * CHANGES, and the implicit /favicon.ico fallback only applies at load — so
 * the dot would linger on the strip. Re-assert the page's own icon (the last
 * one, mirroring Chrome's pick) — or the root favicon.ico a fresh load would
 * fall back to, when the page declared none.
 */
export function restoreFavicon(linkId: string, restoreId: string): void {
  document.getElementById(linkId)?.remove();
  document.getElementById(restoreId)?.remove();

  const own = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
  const restore = document.createElement("link");
  restore.id = restoreId;
  restore.rel = "icon";
  restore.href = own.length > 0 ? (own[own.length - 1]?.href ?? "/favicon.ico") : "/favicon.ico";
  (document.head ?? document.documentElement).appendChild(restore);
}

/**
 * Runs in the page: one heartbeat frame. Reduced motion holds the full frame —
 * checked per beat so a live preference change takes effect without a re-run.
 * A no-op between a navigation wiping the link and the repaint restoring it.
 */
export function stepFaviconFrame(linkId: string, frameUrl: string): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const link = document.getElementById(linkId);
  if (link instanceof HTMLLinkElement) link.href = frameUrl;
}

/**
 * Runs in the page: hand the corner back for the length of one agent click.
 * Toggling an attribute on the host beats reaching for the badge itself — the
 * shadow root is closed, so the CSS inside it is the only way in.
 */
export function setMarksInert(hostIds: string[], inert: boolean): void {
  for (const id of hostIds) {
    const host = document.getElementById(id);
    if (!host) continue;
    if (inert) host.dataset.inert = "1";
    else delete host.dataset.inert;
  }
}

/**
 * Runs in the page: take our marks off the screen entirely, for the length of
 * one screenshot. Inert is not enough here — a walkthrough frame is a document
 * the user hands to someone else, and unlike a live mark it cannot be scrubbed
 * off afterwards. Display, not visibility, so nothing reserves a box.
 */
export function setMarksHidden(hostIds: string[], hidden: boolean): void {
  for (const id of hostIds) {
    const host = document.getElementById(id);
    if (host) host.style.display = hidden ? "none" : "";
  }
}

/**
 * Take a screenshot with our own marks off the page, then put them back.
 * Best-effort on both sides, exactly like the click-through sibling: a page
 * that refuses the toggle has no marks to hide either, and a capture must never
 * fail because the badge would not move. The restore runs even when the capture
 * throws — a run that lost its screenshot must not also lose its badge.
 *
 * ponytail: a repaint landing mid-capture rebuilds the host without the hidden
 * flag, so a navigation finishing at exactly the wrong moment can still put a
 * badge in one frame. The ceiling is one blemished frame; the upgrade path is
 * a paint suppression flag consulted by paintWidget itself.
 */
export async function withMarksHidden<T>(tabId: TabId, act: () => Promise<T>): Promise<T> {
  await inject(tabId, setMarksHidden, [MARK_HOST_IDS, true]);
  try {
    return await act();
  } finally {
    await inject(tabId, setMarksHidden, [MARK_HOST_IDS, false]);
  }
}

/**
 * Run a coordinate click with our marks click-through, so a badge sitting over
 * the element the agent aimed at can never eat the click (and open the panel
 * mid-run, which would move a screen a background run promised not to touch).
 * Awaited on both sides: back-to-back clicks must not restore one while the
 * next is dispatching. Best-effort like every injection — a page that refuses
 * the toggle has no marks to swallow anything either.
 */
export async function withMarksClickThrough<T>(tabId: TabId, act: () => Promise<T>): Promise<T> {
  await inject(tabId, setMarksInert, [MARK_HOST_IDS, true]);
  try {
    return await act();
  } finally {
    await inject(tabId, setMarksInert, [MARK_HOST_IDS, false]);
  }
}

function startPulse(tabId: TabId): void {
  stopPulse(tabId);
  let frame = 0;
  pulseTimers.set(
    tabId,
    setInterval(() => {
      frame = 1 - frame;
      void inject(tabId, stepFaviconFrame, [
        FAVICON_LINK_ID,
        FAVICON_FRAMES[frame] ?? FAVICON_DATA_URL,
      ]);
    }, PULSE_BEAT_MS),
  );
}

function stopPulse(tabId: TabId): void {
  const timer = pulseTimers.get(tabId);
  if (timer !== undefined) clearInterval(timer);
  pulseTimers.delete(tabId);
}

/** False when the page refused the script — the caller decides what that costs. */
async function inject<A extends unknown[]>(
  tabId: TabId,
  func: (...args: A) => void,
  args: A,
): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return true;
  } catch (e) {
    log.debug("indicator injection skipped:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** The driven pill's content — a state sentence, never the task excerpt. */
function drivenState(tabId: TabId, waiting: boolean): WidgetState {
  return {
    mode: "driven",
    task: i18n.t(
      waiting
        ? "indicator.waiting"
        : documentingTabs.has(tabId)
          ? "indicator.documenting"
          : "indicator.driving",
    ),
    queuedText: "",
    awaiting: waiting,
    awaitingText: "",
    hideLabel: i18n.t("widget.hide"),
    openHint: i18n.t("indicator.open"),
    hideHint: i18n.t("widget.hideHint"),
    expandHint: i18n.t("widget.expandHint"),
  };
}

/**
 * A page that refuses the paint refuses every heartbeat frame too — a PDF
 * viewer, a `file://` url without file access, a CSP that blocks injection. So
 * the pulse only starts once the favicon is actually on the page; otherwise the
 * run would spend an `executeScript` every 700ms, forever, drawing nothing.
 * The marks stay tracked either way: a navigation onto a page that does accept
 * them repaints through refreshAgentIndicator, which picks the heartbeat back
 * up. (The pill's own dot pulses in CSS — it needs no frames from here.)
 *
 * Losing the marks is a degradation, not a dead end — the run's green tab group
 * and the toolbar badge (action-badge.ts) carry the signal on any page.
 */
async function paintMarks(tabId: TabId, isCurrent: () => boolean): Promise<void> {
  const waiting = waitingTabs.has(tabId);
  const painted = await inject(tabId, paintFavicon, [
    FAVICON_LINK_ID,
    waiting ? FAVICON_WAITING_URL : FAVICON_DATA_URL,
    RESTORE_LINK_ID,
  ]);
  if (!isCurrent()) return;
  await inject(tabId, paintWidget, [WIDGET_HOST_ID, drivenState(tabId, waiting)]);
  if (!isCurrent()) return;
  // A still state has nothing to beat; a refused paint would beat at nothing.
  if (painted && !waiting) startPulse(tabId);
  else stopPulse(tabId);
}

/** Arming mid-run changes only this tab's label. */
export async function setAgentDocumenting(tabId: TabId, on: boolean): Promise<void> {
  if (on) documentingTabs.add(tabId);
  else documentingTabs.delete(tabId);
  if (drivenTabs.has(tabId)) await updateMarks(tabId, (isCurrent) => paintMarks(tabId, isCurrent));
}

export async function showAgentIndicator(tabId: TabId): Promise<void> {
  waitingTabs.delete(tabId);
  drivenTabs.add(tabId);
  await updateMarks(tabId, (isCurrent) => paintMarks(tabId, isCurrent));
}

/** Repaint after a load wiped the document. No-op unless this tab is marked. */
export async function refreshAgentIndicator(tabId: TabId): Promise<void> {
  if (!drivenTabs.has(tabId)) return;
  await updateMarks(tabId, (isCurrent) => paintMarks(tabId, isCurrent));
}

/** Take the driven marks off a tab — favicon back to the page, pill removed. */
async function clearMarks(tabId: TabId): Promise<void> {
  await inject(tabId, restoreFavicon, [FAVICON_LINK_ID, RESTORE_LINK_ID]);
  await inject(tabId, removeWidget, [WIDGET_HOST_ID]);
}

export async function hideAgentIndicator(tabId: TabId): Promise<void> {
  waitingTabs.delete(tabId);
  documentingTabs.delete(tabId);
  drivenTabs.delete(tabId);
  stopPulse(tabId);
  await updateMarks(tabId, () => clearMarks(tabId));
}

/**
 * The run finished (or failed) with its mark on this tab: settle the pill into
 * the receipt — the same ✓/✗ the strip's group title wears — instead of
 * stripping every sign TabRunner was here, which reads exactly like a crash.
 * The receipt self-clears page-side (SETTLE_MS), so the tab leaves tracking
 * now: a later navigation must not repaint it, and the favicon goes back to
 * the page — the receipt lives on the page, not the strip.
 */
export async function settleAgentIndicator(
  tabId: TabId,
  outcome: "done" | "failed",
): Promise<void> {
  waitingTabs.delete(tabId);
  documentingTabs.delete(tabId);
  drivenTabs.delete(tabId);
  stopPulse(tabId);
  await updateMarks(tabId, async (isCurrent) => {
    await clearMarks(tabId);
    if (!isCurrent()) return;
    await inject(tabId, paintWidget, [WIDGET_HOST_ID, settleState(outcome, "driven")]);
    // The worker clears a receipt if Chrome froze its page-side timer.
    if (isCurrent()) noteReceipt(tabId);
  });
}

/**
 * The run is blocked on the user — a plan to approve, or a question it ended
 * on. Stop the heartbeat and settle both marks into the still "?", badge
 * included: it says what is wanted and, clicked, brings the panel back to
 * answer in. It holds until the next run starts or the tab is unmarked.
 */
export async function waitAgentIndicator(tabId: TabId): Promise<void> {
  waitingTabs.add(tabId);
  drivenTabs.add(tabId);
  stopPulse(tabId);
  await updateMarks(tabId, (isCurrent) => paintMarks(tabId, isCurrent));
}

/** Clear this tab's pending wait without changing any other run's mark. */
export async function clearAgentWait(tabId: TabId): Promise<void> {
  if (waitingTabs.has(tabId)) await hideAgentIndicator(tabId);
}
