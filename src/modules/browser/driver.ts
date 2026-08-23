import { captureSnapshot, resolveRefRect } from "./snapshot";
import type { SnapshotOptions, SnapshotResult } from "./snapshot";
import { capturePageText } from "./page-text";
import type { PageTextResult } from "./page-text";
import { fillField } from "./fill";
import { sanitizeForModel } from "./sanitize";
import { listRequests, listConsoleMessages } from "./inspect";
import type { RequestEntry, ConsoleEntry } from "./inspect";
import {
  clickAt,
  typeText,
  insertText,
  pressKey,
  scroll,
  screenshot,
  evaluateRaw,
  navigateToUrl,
  goBack as goBackInTab,
  waitForLoad,
  settleIfLoading,
  ensureAttached,
} from "./cdp-driver";
import { focusTab } from "./focus-tab";
import { withMarksClickThrough } from "./indicator";
import { i18n } from "@/i18n";
import { truncate } from "@/lib/logger";
import type { TabId } from "@/shared/types";

/**
 * Driver — single interface over snapshot (scripting) + actions (CDP).
 * Exists because the two halves use different mechanisms with different failure modes.
 * This is also the test seam.
 */

/** One open tab, as the model needs to see it — labels bounded so a 100-tab session stays cheap. */
export interface TabInfo {
  id: TabId;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  favIconUrl?: string;
}

/** Past this many hits the query was too loose to be worth answering in full. */
const MAX_FIND_MATCHES = 50;

/** Snapshot lines matching a query — a targeted lookup on a page too big to re-read. */
export interface FindResult {
  query: string;
  url: string;
  matches: string[];
  total: number;
}

export interface BrowserDriver {
  snapshot(opts?: SnapshotOptions): Promise<SnapshotResult>;
  /** The page as prose — what the snapshot's 100-char name cap cannot carry. */
  readPageText(from?: number, limit?: number): Promise<PageTextResult>;
  /** The snapshot, filtered to what matches — refs included, at a fraction of the tokens. */
  find(query: string, limit?: number): Promise<FindResult>;
  click(ref: string): Promise<{ x: number; y: number }>;
  type(text: string): Promise<void>;
  insert(text: string): Promise<void>;
  /**
   * Set a field's value page-side (native setter + input/change) — the fallback
   * for when trusted keystrokes don't land. Runs via scripting, no debugger.
   */
  fill(ref: string, text: string): Promise<void>;
  /**
   * Run JS in the page's main world (CDP — CSP-exempt, promises awaited) and
   * hand back the sanitized, bounded result. Needs the debugger.
   */
  evaluate(expression: string): Promise<unknown>;
  /** The tab's network log since attach — method, url, status, failure; no bodies. */
  readNetworkRequests(
    urlFilter?: string,
    limit?: number,
  ): Promise<{ requests: RequestEntry[]; total: number; note?: string }>;
  /** The tab's console output and uncaught exceptions since attach. */
  readConsoleMessages(
    onlyErrors?: boolean,
    limit?: number,
  ): Promise<{ messages: ConsoleEntry[]; total: number; note?: string }>;
  key(key: string, modifiers?: string[]): Promise<void>;
  /** Back one entry in the driven tab's history — the way out of a dead end. */
  goBack(): Promise<void>;
  scrollDown(amount?: number): Promise<void>;
  scrollUp(amount?: number): Promise<void>;
  screenshot(): Promise<string>;
  navigate(url: string): Promise<void>;
  listTabs(): Promise<TabInfo[]>;
  /** Re-targets every later action at this tab — foregrounding it is `activateOnSwitch`'s call. */
  switchTab(tabId: TabId): Promise<TabInfo>;
  /** Open a tab of the run's own and drive it — the user's stays where it was. */
  openTab(url: string): Promise<TabInfo>;
  /** Close a tab the run is finished with. Never the one it is driving. */
  closeTab(tabId: TabId): Promise<TabInfo>;
  /**
   * Files another open tab into the run's task group. Chrome constraint: groups
   * are window-scoped, so a tab in another window can't join — moving it across
   * windows would rip it out of the user's screen setup, which is theirs to do.
   */
  groupTab(tabId: TabId, groupId: number): Promise<TabInfo>;
  /**
   * Brief post-action watch for a page load, riding one out if it starts.
   * Reports whether the page went anywhere. The loop calls it between a turn's
   * calls, where there is no model latency to absorb a navigation.
   */
  settle(): Promise<boolean>;
}

export interface DriverOptions {
  /**
   * Fires when the agent re-targets itself mid-run — the background moves the
   * on-page badge and the panel's driving chip with it.
   */
  onSwitch?: (tab: TabInfo) => void;
  /**
   * May a switched-to tab be brought to the front? Asked at every switch, not
   * at run start: "is someone watching" is a fact that changes mid-run — the
   * panel closes, or the user opens it again — and a start-time flag would have
   * a walked-away run still yanking their window. Even when it answers yes the
   * follow holds only while the user is sitting on the tab being left: once
   * they move to a tab of their own the run re-targets in silence. Nobody
   * watching means nothing moves — that is what "in background" promises, and
   * CDP input reaches an inactive tab either way. The cost of an unfollowed
   * switch is that a background tab gets no rAF ticks, so a page whose UI only
   * advances on animation frames can stall — a reason to keep the panel open
   * for one, not to steal focus for all.
   */
  activateOnSwitch?: () => boolean;
}

/** One open tab, shaped for the model — undefined for the id-less records a query can return. */
function toTabInfo(t: chrome.tabs.Tab): TabInfo | undefined {
  if (t.id === undefined) return undefined;
  return {
    id: t.id,
    windowId: t.windowId,
    title: truncate(t.title ?? "", 80),
    url: truncate(t.url ?? "", 120),
    active: t.active === true,
    ...(t.favIconUrl ? { favIconUrl: t.favIconUrl } : {}),
  };
}

export function createDriver(initialTabId: TabId, opts: DriverOptions = {}): BrowserDriver {
  const { onSwitch, activateOnSwitch = () => true } = opts;
  // The run starts on the submit-time tab but may hop: the CDP layer is
  // multi-tab (attach re-targets per call), so the driver just tracks a target.
  let current = initialTabId;

  const driver: BrowserDriver = {
    async snapshot(opts) {
      return captureSnapshot(current, opts);
    },

    async readPageText(from, limit) {
      return capturePageText(current, from, limit);
    },

    async find(query, limit = MAX_FIND_MATCHES) {
      // Built on the snapshot rather than a walk of its own: one ref registry,
      // one notion of what an element is called. The saving is in what crosses
      // the wire, not in what the page does.
      const snap = await captureSnapshot(current);
      const needle = query.trim().toLowerCase();
      const hits = snap.pageContent
        .split("\n")
        // The indent encoded a tree these lines are no longer part of.
        .map((line) => line.trim())
        .filter((line) => line.toLowerCase().includes(needle));
      const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_FIND_MATCHES);
      return { query, url: snap.url, matches: hits.slice(0, cap), total: hits.length };
    },

    async click(ref) {
      await ensureAttached(current);
      const rect = await resolveRefRect(current, ref);
      const cx = Math.round(rect.x + rect.width / 2);
      const cy = Math.round(rect.y + rect.height / 2);
      // The click is a coordinate, so whatever sits at it wins — including our
      // own marks. They go click-through for the dispatch: a badge that ate the
      // agent's click would both lose the step and open a panel nobody asked for.
      await withMarksClickThrough(current, () => clickAt(cx, cy));
      return { x: cx, y: cy };
    },

    async type(text) {
      await ensureAttached(current);
      await typeText(text);
    },

    async insert(text) {
      await ensureAttached(current);
      await insertText(text);
    },

    async fill(ref, text) {
      // Page-side by design: no debugger, no infobar — the same mechanism the
      // snapshot uses, aimed at one element.
      await fillField(current, ref, text);
    },

    async evaluate(expression) {
      await ensureAttached(current);
      return sanitizeForModel(await evaluateRaw(expression));
    },

    async readNetworkRequests(urlFilter, limit) {
      // Attach first so the capture is live even on a run that has only read.
      await ensureAttached(current);
      return listRequests(current, urlFilter, limit);
    },

    async readConsoleMessages(onlyErrors, limit) {
      await ensureAttached(current);
      return listConsoleMessages(current, onlyErrors, limit);
    },

    async key(key, modifiers) {
      await ensureAttached(current);
      await pressKey(key, modifiers);
    },

    async goBack() {
      await goBackInTab(current);
    },

    async scrollDown(amount = 300) {
      await ensureAttached(current);
      await scroll(0, amount);
    },

    async scrollUp(amount = 300) {
      await ensureAttached(current);
      await scroll(0, -amount);
    },

    async screenshot() {
      await ensureAttached(current);
      return screenshot();
    },

    async navigate(url) {
      await navigateToUrl(current, url);
    },

    async listTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.flatMap((t) => toTabInfo(t) ?? []);
    },

    async groupTab(tabId, groupId) {
      // Both throws land as tool errors the model can act on: a dead tab id
      // means re-list, a dead group means the run's strip is gone.
      const [tab, group] = await Promise.all([
        chrome.tabs.get(tabId),
        chrome.tabGroups.get(groupId),
      ]);
      if (tab.windowId !== group.windowId) {
        throw new Error(i18n.t("errors.tabGroupOtherWindow"));
      }
      await chrome.tabs.group({ tabIds: tabId, groupId });
      const info = toTabInfo(tab);
      if (!info) throw new Error(i18n.t("errors.noActiveTab"));
      return info;
    },

    async switchTab(tabId) {
      // chrome.tabs.get throws for a dead id — the model then re-lists.
      const tab = await chrome.tabs.get(tabId);
      // A watched run brings the switched-to tab forward only while the user is
      // sitting on the tab being left — they are watching the work, so the work
      // stays in view. Once they move to a tab of their own, the run re-targets
      // in silence: the sidebar is the watch surface and nobody's navigation
      // gets yanked. The window is never pulled either way — that's the user's
      // call, not the run's.
      let followed = false;
      if (activateOnSwitch()) {
        const [visible] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        followed = visible?.id === current;
        if (followed) await focusTab(tabId, tab.windowId, { pullWindow: false });
      }
      current = tabId;
      const info: TabInfo = {
        id: tabId,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        active: followed ? true : tab.active === true,
        ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      };
      onSwitch?.(info);
      return info;
    },

    async openTab(url) {
      // Created in the background and only then switched to, so the follow
      // rule is switchTab's one implementation: a watched run brings it
      // forward, a background run never yanks the user's window.
      const tab = await chrome.tabs.create({ url, active: false });
      if (tab.id === undefined) throw new Error(i18n.t("errors.tabOpenFailed"));
      await waitForLoad(tab.id);
      return driver.switchTab(tab.id);
    },

    async closeTab(tabId) {
      // Closing the tab underneath the run would leave every later action
      // pointed at a dead id. Switching away first is the model's call to
      // make, not something to guess at here.
      if (tabId === current) throw new Error(i18n.t("errors.closeDrivenTab"));
      // Read it before it goes — the step row names what closed, the way a
      // switch names where it landed; a dead id throws here, not in remove.
      const tab = await chrome.tabs.get(tabId);
      const info = toTabInfo(tab);
      if (!info) throw new Error(i18n.t("errors.noActiveTab"));
      await chrome.tabs.remove(tabId);
      return info;
    },

    settle: () => settleIfLoading(current),
  };

  return driver;
}
