import { i18n } from "@/i18n";
import { widgetHidden } from "@/lib/prefs";
import { createLogger } from "@/lib/logger";
import { isRestrictedUrl } from "./restricted-url";

const log = createLogger("widget");
/** Shared with indicator.ts, which makes every mark inert around agent clicks. */
export const WIDGET_HOST_ID = "tabrunner-status-widget";

/**
 * The ONE on-page mark — a single pill injected into a page's top-right corner,
 * speaking for the run in two voices and four states:
 *
 * - driven (indicator.ts's lifecycle, on the tab being worked): "TabRunner is
 *   controlling this tab" — the mark that keeps a self-typing tab from looking
 *   possessed;
 * - ambient (this file's lifecycle, on every window's active tab but the driven
 *   one): "TabRunner · task" — the dispatch-and-forget signal on whatever the
 *   user is actually looking at;
 * - waiting (either voice): the pulse settles into a still "?" — blocked on
 *   you, not working;
 * - settled: a run's receipt. When a run ends, the mark does not quietly
 *   vanish — it settles into the same ✓/✗ the run's tab group wears, and the
 *   page takes it down itself after a few seconds. An ending you can see beats
 *   one you infer from a mark that disappeared. Three exits, because the page
 *   timer is the one that can fail (a background tab Chrome froze runs no
 *   timers at all, and the receipt then outstays the run by however long the
 *   user is away): the timer, the click that opens the panel, and its own ✕.
 *   Coming back to the tab is a fourth — see clearStaleReceipts.
 *
 * One host id, one paint function, one Hide button: the corner is always the
 * same, so the eye learns exactly one place to look, and the words alone say
 * which situation you are in. The richest of the run signals, and the most
 * fragile: injection can be refused, and the user can collapse the pill to a
 * dot or switch it off for good (`widgetHidden` — the ambient voice only; the
 * driven tab's badge is the run's own signature and outlives the pref, its
 * favicon dot with it). Neither is a dead end — the toolbar badge
 * (action-badge.ts) is the floor beneath everything, and it is never injected.
 *
 * Mirrors indicator.ts: a serialized, self-contained page function, a closed
 * shadow root the page cannot restyle or reach into, best-effort injection
 * (restricted pages reject it and must never matter), and repaint-on-load
 * because every navigation wipes the document.
 *
 * Clickable, like every mark — it is the way back to the run — so pointer
 * events stay on, confined to the pill. The click messages the worker (the
 * isolated world that executeScript runs in has extension API access); "hide"
 * never leaves the page — it collapses the pill to a small blinking status
 * dot, and clicking the dot brings the pill back. Collapse survives repaints
 * (host dataset) but not navigation, which wipes the document anyway. Hiding
 * the widget for good stays in Settings (`widgetHidden` pref).
 */

/** What one paint needs — pre-digested by the worker (i18n, excerpts). */
export interface WidgetState {
  /** driven = the run is working this very tab; ambient = it is elsewhere. */
  mode: "driven" | "ambient";
  /** The headline: a state sentence (driven) or the task excerpt (ambient). */
  task: string;
  /** The steering message, when the headline is the conversation's title
   *  instead — the tooltip's identity. Absent when the headline already is
   *  the excerpt. */
  taskTip?: string;
  /** "+N queued" chip text — empty when nothing waits. */
  queuedText: string;
  /** Parked on the user's answer — the pulse becomes a still "?". */
  awaiting: boolean;
  /** What the task line says while parked ("" keeps the task excerpt): a parked
   *  run's excerpt can't say it is blocked on you, so the state leads and the
   *  excerpt moves to the tooltip. */
  awaitingText: string;
  /** The run's receipt — painted where the working mark was; the page clears
   *  it (SETTLE_MS), and the ✕ / a click on the pill clear it sooner. */
  settle?: { ok: boolean; text: string };
  hideLabel: string;
  /** The pill's own tooltip — clicking anywhere on it opens the panel. */
  openHint: string;
  /** Collapse-to-dot tooltip; the dot's own tooltip is `expandHint`. */
  hideHint: string;
  expandHint: string;
}

/** How long a settled receipt lingers before the page takes it down itself. */
const SETTLE_MS = 6000;

/** Tabs currently showing the ambient pill — repaint and removal consult this. */
const widgetTabs = new Set<number>();
/**
 * Tabs the driven lifecycle (indicator.ts) currently marks. The two voices
 * share one host, so the ambient half must never paint over — or remove — a
 * driven badge: a switch_tab hands a tab from one lifecycle to the other, and
 * without this guard the board sync racing the handover could strip the fresh
 * driven mark. Read by indicator.ts; written through add/delete there too.
 */
export const drivenTabs = new Set<number>();

/** The last sync's inputs — activation churn reconciles against them. */
let lastState: WidgetState | null = null;
let lastExclude: number | undefined;

/**
 * Tabs wearing a run's receipt, and when the newest one was painted. The page
 * clears its own (SETTLE_MS) — but only a page whose timers run: Chrome freezes
 * background tabs, and a frozen tab keeps the mark until the user comes back to
 * it, which is exactly when a stale "Task finished" is most confusing. So the
 * worker keeps the note and finishes the job on the next activation.
 */
let receipts: { at: number; tabs: Set<number> } | null = null;

/** Marks a tab as wearing a receipt — including the driven tab's, which
 *  indicator.ts paints into this same host. */
export function noteReceipt(tabId: number): void {
  receipts = { at: Date.now(), tabs: (receipts?.tabs ?? new Set<number>()).add(tabId) };
}

/**
 * Take down receipts the page should have cleared itself. Only past SETTLE_MS —
 * before that the receipt is still being read — and never a tab that has since
 * been given a mark of its own: a new run's pill is not this one's to remove.
 */
async function clearStaleReceipts(): Promise<void> {
  if (!receipts || Date.now() - receipts.at < SETTLE_MS) return;
  const stale = [...receipts.tabs].filter((id) => !drivenTabs.has(id) && !widgetTabs.has(id));
  receipts = null;
  await Promise.all(stale.map((tabId) => inject(tabId, removeWidget, [WIDGET_HOST_ID])));
}

/**
 * Runs in the page. Must be fully self-contained — it is serialized, not closed
 * over. A click posts its intent to the worker and never sees the answer — the
 * side panel simply opens. "Hide" is purely local: it collapses the pill to the
 * status dot, and the dot expands back. The collapsed flag lives on the host's
 * dataset so a repaint (fresh board content re-injects this function) keeps it.
 *
 * scripts/shoot-store.ts hand-mirrors this markup for store screenshots —
 * change one, change both.
 */
export function paintWidget(hostId: string, state: WidgetState): void {
  const old = document.getElementById(hostId);
  // A repaint that changes nothing must not wipe the pill: rebuilding the host
  // drops in-pill focus and hover mid-gesture. The painted inputs sign the
  // host; an identical repaint leaves the DOM (and its collapsed flag) alone.
  const signature = JSON.stringify(state);
  if (old?.dataset.signature === signature) return;
  const wasCollapsed = old?.dataset.collapsed === "1";
  old?.remove();

  const host = document.createElement("div");
  host.id = hostId;
  host.dataset.signature = signature;
  // The host lives in page CSS space — an author `!important` rule (or a
  // cosmetic filter) could demote or hide it. The critical box properties go
  // in with priority; the closed shadow root already protects everything inside.
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "12px", "important");
  host.style.setProperty("right", "12px", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.fontFamily = "ui-sans-serif,system-ui,sans-serif";

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  /* Hexes are runtime copies of theme.css tokens (a page function can't import
     them): #0b1224 = neutral-900, #e8eefb = neutral-100, #6ee7b7 = brand-300,
     #34d399 = brand-400, #fbbf24 = amber-400, #fcd34d = amber-300,
     #451a03 = amber-950, #022c22 = emerald-950, #dc2626 = red-600. A brand
     pass recolors here too. */
  style.textContent = `
    .pill {
      display: flex; align-items: center;
      max-width: calc(100vw - 24px);
      padding: 6px 8px 6px 10px; border-radius: 9999px;
      background: #0b1224ee; color: #e8eefb;
      font: 500 12px/1.2 ui-sans-serif, system-ui, sans-serif;
      /* The dark shadow alone dissolved into dark pages — the mini's resting
         emerald ring is what keeps the silhouette an object. */
      box-shadow: 0 2px 12px #0000004d, 0 0 0 1px #34d39966;
    }
    /* A failed receipt wears its own ring — emerald would read as success. */
    .pill.bad { box-shadow: 0 2px 12px #0000004d, 0 0 0 1px #dc262666; }
    .pill:has(.open:hover), .pill:has(.open:focus-visible) { background: #0b1224; }
    /* The pill's content IS the open control — a transparent button filling it,
       so the whole thing reads as one target and still answers to the keyboard.
       A sibling of Hide, never its parent: nested buttons are not a thing. */
    .open {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      border: 0; background: transparent; color: inherit; font: inherit;
      padding: 0; cursor: pointer;
    }
    .open:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; border-radius: 9999px; }
    /* Set around an agent click — see withMarksClickThrough in indicator.ts.
       Covers the driven tab's own badge and the moment a switch_tab leaves an
       ambient pill behind on a tab the run is now driving. */
    :host([data-inert]) .pill, :host([data-inert]) .mini { pointer-events: none }
    .dot {
      width: 6px; height: 6px; border-radius: 9999px; flex: none;
      background: #fbbf24; animation: pulse 1.4s ease-in-out infinite;
    }
    .wait, .end {
      width: 14px; height: 14px; border-radius: 9999px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
    }
    .wait { background: #fbbf24; color: #451a03; }
    /* The receipt speaks the strip's settle language: ✓ done, ✗ failed. */
    .end.ok { background: #34d399; color: #022c22; }
    .end.bad { background: #dc2626; color: #ffffff; }
    @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
    .brand { flex: none; color: #6ee7b7; }
    .task { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queued {
      flex: none; padding: 1px 6px; border-radius: 9999px;
      /* A count is measurement — gold, not the emerald that means motion. */
      background: #fbbf2426; color: #fcd34d; font-size: 11px;
    }
    .btn {
      flex: none; border: 0; border-radius: 9999px; padding: 5px 10px;
      background: transparent; color: #6ee7b7; font: inherit; cursor: pointer;
    }
    .btn:hover { background: #34d39933; color: #e8eefb; }
    .mini {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border: 0; border-radius: 9999px; padding: 0;
      background: #0b1224ee; box-shadow: 0 2px 12px #0000004d, 0 0 0 1px #34d39966; cursor: pointer;
    }
  `;

  // The status glyph is decorative — the buttons around it carry their own
  // names, and a bare "?" or "✓" must never be what a screen reader announces.
  const makeStatus = (): HTMLSpanElement => {
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    if (state.settle) {
      mark.className = state.settle.ok ? "end ok" : "end bad";
      mark.textContent = state.settle.ok ? "✓" : "✗";
    } else if (state.awaiting) {
      // Parked on an answer speaks the favicon's wait language: a still "?",
      // never the pulse — motion is the "working" signal and the run is
      // blocked on you.
      mark.className = "wait";
      mark.textContent = "?";
    } else {
      mark.className = "dot";
    }
    return mark;
  };

  const pill = document.createElement("div");
  pill.className = state.settle && !state.settle.ok ? "pill bad" : "pill";
  // Everything but Hide is the way back, like every mark — a labeled "Open"
  // button inside a clickable pill was two controls for one action, and the
  // pill is the bigger target.
  const open = document.createElement("button");
  open.className = "open";
  open.type = "button";
  open.title = state.openHint;
  open.setAttribute("aria-label", state.openHint);
  open.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "tabrunner-mark", action: "open" });
    // A read receipt is a read receipt: the panel is opening with the result in
    // it, so the pill has nothing left to say. Only the receipt goes — a live
    // run's pill is a status, and status outlives the glance you gave it.
    if (state.settle) host.remove();
  });
  // Self-identifying on unrelated pages — but only the ambient voice needs it:
  // the driven badge's sentence already names TabRunner.
  const text = document.createElement("span");
  text.className = "task";
  // Parked: the state leads ("Waiting for your approval"), the task excerpt
  // keeps the tooltip. Settled: the receipt. Working: the excerpt, as always.
  text.textContent = state.awaitingText || (state.settle ? state.settle.text : state.task);
  if (state.mode === "ambient" && !state.settle) text.title = state.taskTip ?? state.task;
  open.append(makeStatus());
  if (state.mode === "ambient") {
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "TabRunner ·";
    open.appendChild(brand);
  }
  open.appendChild(text);
  if (state.queuedText) {
    const queued = document.createElement("span");
    queued.className = "queued";
    queued.textContent = state.queuedText;
    open.appendChild(queued);
  }
  pill.appendChild(open);
  // Collapsed form: just the status mark in a small round button — still
  // blinking while working, and the way back to the pill.
  const mini = document.createElement("button");
  mini.className = "mini";
  mini.type = "button";
  mini.title = state.expandHint;
  // The name, not just the tooltip — content would win over title, and the
  // waiting glyph would announce this button as "question mark".
  mini.setAttribute("aria-label", state.expandHint);
  mini.appendChild(makeStatus());

  const setCollapsed = (collapsed: boolean): void => {
    host.dataset.collapsed = collapsed ? "1" : "0";
    pill.style.display = collapsed ? "none" : "";
    mini.style.display = collapsed ? "" : "none";
  };
  // One control, two jobs, because the two states want opposite things: a
  // working pill collapses (it has more to say later), a receipt leaves for
  // good. Neither state is without a way out — a mark on someone's page must
  // always be one click from gone.
  const hide = document.createElement("button");
  hide.className = "btn";
  hide.type = "button";
  hide.textContent = state.hideLabel;
  hide.title = state.hideHint;
  // A glyph is not a name — the receipt's ✕ borrows its label from the tooltip.
  if (state.settle) hide.setAttribute("aria-label", state.hideHint);
  hide.addEventListener("click", () => (state.settle ? host.remove() : setCollapsed(true)));
  pill.append(hide);
  mini.addEventListener("click", () => setCollapsed(false));

  root.append(style, pill, mini);
  setCollapsed(wasCollapsed);
  (document.body ?? document.documentElement).appendChild(host);

  // The receipt clears itself page-side: no worker timer to die with an MV3
  // restart, and a stale receipt can never outlive its own welcome. The
  // signature guard keeps an old timer from taking down a mark a newer paint
  // (the next run's pill) has since put in its place.
  if (state.settle) {
    setTimeout(() => {
      const el = document.getElementById(hostId);
      if (el?.dataset.signature === signature) el.remove();
    }, SETTLE_MS);
  }
}

/** Runs in the page. */
export function removeWidget(hostId: string): void {
  document.getElementById(hostId)?.remove();
}

/** How a run's ending reads on the mark. */
export type SettleOutcome = "done" | "failed";

/** The receipt a run leaves where its working mark was — the page clears it. */
export function settleState(outcome: SettleOutcome, mode: "driven" | "ambient"): WidgetState {
  const ok = outcome === "done";
  return {
    mode,
    task: "",
    queuedText: "",
    awaiting: false,
    awaitingText: "",
    settle: { ok, text: i18n.t(ok ? "widget.settledDone" : "widget.settledFailed") },
    // The receipt's own way out. A glyph, not a word: "Hide" would promise the
    // collapse it no longer does, and ✕ needs no translating — the name behind
    // it does.
    hideLabel: "✕",
    openHint: i18n.t(mode === "driven" ? "indicator.open" : "widget.settledHint"),
    hideHint: i18n.t("widget.dismiss"),
    expandHint: "",
  };
}

function argsOf(state: WidgetState): Parameters<typeof paintWidget> {
  return [WIDGET_HOST_ID, state];
}

async function inject<A extends unknown[]>(
  tabId: number,
  func: (...args: A) => void,
  args: A,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (e) {
    log.debug("widget injection skipped:", e instanceof Error ? e.message : String(e));
  }
}

/** Each window's active tab, minus restricted pages, the driven tab, and any
 *  tab the driven lifecycle currently marks (one host — never paint over it). */
async function eligibleTabs(excludeTabId?: number): Promise<Set<number>> {
  const eligible = new Set<number>();
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ active: true });
  } catch {
    return eligible;
  }
  for (const tab of tabs) {
    if (
      tab.id === undefined ||
      tab.id === excludeTabId ||
      drivenTabs.has(tab.id) ||
      isRestrictedUrl(tab.url)
    )
      continue;
    eligible.add(tab.id);
  }
  return eligible;
}

/** Drop the pill from tracked tabs that fell out of the eligible set. */
async function removeFrom(ineligible: number[]): Promise<void> {
  await Promise.all(
    ineligible.map((tabId) => {
      widgetTabs.delete(tabId);
      // A tab that left eligibility because the driven lifecycle took it over
      // bears that mark now — removing the shared host would strip it.
      if (drivenTabs.has(tabId)) return Promise.resolve();
      return inject(tabId, removeWidget, [WIDGET_HOST_ID]);
    }),
  );
}

async function removeEverywhere(): Promise<void> {
  const tabs = [...widgetTabs];
  widgetTabs.clear();
  await Promise.all(tabs.map((tabId) => inject(tabId, removeWidget, [WIDGET_HOST_ID])));
}

/**
 * Paint the pill on each window's active tab (never the driven tab), or remove
 * it everywhere when there is nothing to report (or the user hid it — the
 * caller passes null then). Repaints every tracked tab: the content may have
 * changed with the board.
 */
export async function syncStatusWidget(
  state: WidgetState | null,
  excludeTabId?: number,
): Promise<void> {
  lastState = state;
  lastExclude = excludeTabId;
  if (!state) {
    await removeEverywhere();
    return;
  }
  const eligible = await eligibleTabs(excludeTabId);
  await removeFrom([...widgetTabs].filter((id) => !eligible.has(id)));
  const args = argsOf(state);
  await Promise.all(
    [...eligible].map((tabId) => {
      widgetTabs.add(tabId);
      return inject(tabId, paintWidget, args);
    }),
  );
}

/**
 * Activation/focus churn against the last sync: paint the newly active, pull
 * the pill from tabs that lost activation. No content re-digest — the board
 * drives that through syncStatusWidget.
 */
export async function reconcileStatusWidgets(): Promise<void> {
  // Before anything else, and whether or not a run is on: coming back to a tab
  // is how a stuck receipt gets noticed, so it is also how it gets cleared.
  await clearStaleReceipts();
  if (!lastState) return;
  const eligible = await eligibleTabs(lastExclude);
  await removeFrom([...widgetTabs].filter((id) => !eligible.has(id)));
  const fresh = [...eligible].filter((id) => !widgetTabs.has(id));
  const args = argsOf(lastState);
  await Promise.all(
    fresh.map((tabId) => {
      widgetTabs.add(tabId);
      return inject(tabId, paintWidget, args);
    }),
  );
}

/** Repaint after a load wiped the document. No-op unless this tab has the pill. */
export async function refreshStatusWidget(tabId: number, state: WidgetState): Promise<void> {
  if (!widgetTabs.has(tabId) || drivenTabs.has(tabId)) return;
  await inject(tabId, paintWidget, argsOf(state));
}

/**
 * The run is over and the board it lived on is empty: leave the receipt on the
 * tabs that were showing the pill, in place of removing it. One-shot — the
 * receipt self-clears page-side, so it joins no tracking set and no activation
 * churn follows it. The driven tab's own receipt is `settleAgentIndicator`'s;
 * the exclude keeps this from painting a second one over it.
 */
export async function settleStatusWidgets(
  outcome: SettleOutcome,
  excludeTabId?: number,
): Promise<void> {
  if (await widgetHidden.get()) return;
  const eligible = await eligibleTabs(excludeTabId);
  const args = argsOf(settleState(outcome, "ambient"));
  await Promise.all(
    [...eligible].map((tabId) => {
      noteReceipt(tabId);
      return inject(tabId, paintWidget, args);
    }),
  );
}

/**
 * Remove the pill without knowing where it is — a restarted worker's sweep:
 * the tracking sets died with the old worker, the pills did not. With one host
 * id this also takes down orphaned driven badges.
 */
export async function sweepStatusWidget(): Promise<void> {
  widgetTabs.clear();
  drivenTabs.clear();
  receipts = null;
  lastState = null;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const removals: Promise<void>[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || isRestrictedUrl(tab.url)) continue;
    removals.push(inject(tab.id, removeWidget, [WIDGET_HOST_ID]));
  }
  await Promise.all(removals);
}
