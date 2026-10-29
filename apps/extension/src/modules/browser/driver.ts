import { captureSnapshot, resolveRefPoint } from "./snapshot";
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
  claimTab,
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
  /**
   * Whether the tab this run opened at start has still had no action land on
   * it, so teardown can close a starter tab the run never used.
   */
  readonly unactedTab?: boolean;
}

export interface DriverOptions {
  /** The run or direct session that exclusively owns this driver's tabs. */
  ownerId: string;
  /**
   * Fires when the agent re-targets itself mid-run — the background moves the
   * on-page badge and the panel's driving chip with it.
   */
  onSwitch?: (tab: TabInfo) => void | Promise<void>;
  /**
   * May a switched-to tab be brought to the front? Asked at every switch, not
   * at run start: "is someone watching" is a fact that changes mid-run — the
   * panel closes, or the user opens it again — and a start-time flag would have
   * a walked-away run still yanking their window. Even when it answers yes the
   * follow holds only while the user is sitting on the tab being left: once
   * they move to a tab of their own the run re-targets in silence. Nobody
   * watching means nothing moves — that is what "in background" promises, and
   * CDP input reaches an inactive tab either way: attach turns on focus
   * emulation, which also makes the page act visible, so animation frames keep
   * ticking and nothing here needs the tab on screen.
   */
  activateOnSwitch?: () => boolean;
  /**
   * True when `initialTabId` was opened for this run. Any action on it claims
   * it; switching away before that closes it as litter, and `openTab`
   * navigates it in place instead of opening a second tab beside an unused one.
   */
  openedTab?: boolean;
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

export function createDriver(initialTabId: TabId, opts: DriverOptions): BrowserDriver {
  const { ownerId, onSwitch, activateOnSwitch = () => true, openedTab = false } = opts;
  claimTab(ownerId, initialTabId);
  let current = initialTabId;
  let unactedTabId: TabId | null = openedTab ? initialTabId : null;
  const noteAction = (tabId: TabId) => {
    if (tabId === unactedTabId) unactedTabId = null;
  };

  const driver: BrowserDriver = {
    get unactedTab() {
      return unactedTabId !== null;
    },

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
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      const { x, y } = await resolveRefPoint(tabId, ref);
      // The click is a coordinate, so whatever sits at it wins, including our
      // own marks. Keep one target through the lookup and trusted input.
      await withMarksClickThrough(tabId, () => clickAt(tabId, x, y));
      noteAction(tabId);
      return { x, y };
    },

    async type(text) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      await typeText(tabId, text);
      noteAction(tabId);
    },

    async insert(text) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      await insertText(tabId, text);
      noteAction(tabId);
    },

    async fill(ref, text) {
      const tabId = current;
      // Page-side by design: no debugger, no infobar.
      await fillField(tabId, ref, text);
      noteAction(tabId);
    },

    async evaluate(expression) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      const raw = await evaluateRaw(tabId, expression);
      noteAction(tabId);
      return sanitizeForModel(raw);
    },

    async readNetworkRequests(urlFilter, limit) {
      const tabId = current;
      // Attach first so the capture is live even on a run that has only read.
      await ensureAttached(ownerId, tabId);
      return listRequests(tabId, urlFilter, limit);
    },

    async readConsoleMessages(onlyErrors, limit) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      return listConsoleMessages(tabId, onlyErrors, limit);
    },

    async key(key, modifiers) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      await pressKey(tabId, key, modifiers);
      noteAction(tabId);
    },

    async goBack() {
      const tabId = current;
      await goBackInTab(tabId);
      noteAction(tabId);
    },

    async scrollDown(amount = 300) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      await scroll(tabId, 0, amount);
      noteAction(tabId);
    },

    async scrollUp(amount = 300) {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      await scroll(tabId, 0, -amount);
      noteAction(tabId);
    },

    async screenshot() {
      const tabId = current;
      await ensureAttached(ownerId, tabId);
      return screenshot(tabId);
    },

    async navigate(url) {
      const tabId = current;
      await navigateToUrl(tabId, url);
      noteAction(tabId);
    },

    async listTabs() {
      const tabs = await chrome.tabs.query({});
      return tabs.flatMap((t) => toTabInfo(t) ?? []);
    },

    async groupTab(tabId, groupId) {
      claimTab(ownerId, tabId);
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
      claimTab(ownerId, tabId);
      const previous = current;
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
        followed = visible?.id === previous;
        if (followed) await focusTab(tabId, tab.windowId, { pullWindow: false });
      }
      const abandoned = unactedTabId !== null && unactedTabId !== tabId ? unactedTabId : null;
      if (abandoned !== null) unactedTabId = null;
      current = tabId;
      const info: TabInfo = {
        id: tabId,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        active: followed ? true : tab.active === true,
        ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      };
      await onSwitch?.(info);
      if (abandoned !== null) void chrome.tabs.remove(abandoned).catch(() => {});
      return info;
    },

    async openTab(url) {
      // A run still sitting on the untouched tab it opened already has a fresh
      // tab of its own: navigate that one in place instead of spawning a second
      // tab and leaving the first behind on the start page.
      if (unactedTabId !== null && current === unactedTabId) {
        const tabId = current;
        await navigateToUrl(tabId, url);
        noteAction(tabId);
        return driver.switchTab(tabId);
      }
      // Created in the background and only then switched to, so the follow
      // rule is switchTab's one implementation: a watched run brings it
      // forward, a background run never yanks the user's window.
      const tab = await chrome.tabs.create({ url, active: false });
      if (tab.id === undefined) throw new Error(i18n.t("errors.tabOpenFailed"));
      claimTab(ownerId, tab.id);
      await waitForLoad(tab.id);
      return driver.switchTab(tab.id);
    },

    async closeTab(tabId) {
      claimTab(ownerId, tabId);
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
