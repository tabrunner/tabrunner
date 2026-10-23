import { i18n } from "@/i18n";
import { acquireRun, releaseRun } from "@/modules/agent/active-runs";
import type { ActiveRun } from "@/modules/agent/active-runs";
import { clearPendingQuestion, markRunningTab, trackRunningRun } from "@/modules/agent/run-queue";
import { executeTool, formatDetail, formatSuccessSummary } from "@/modules/agent/tools";
import type { ToolResult } from "@/modules/agent/tools";
import {
  claimTab,
  createDriver,
  hideAgentIndicator,
  isRestrictedUrl,
  releaseBrowserOwner,
  showAgentIndicator,
  waitForLoad,
} from "@/modules/browser";
import type { BrowserDriver } from "@/modules/browser";
import {
  appendMessageTo,
  getThreadTabsFor,
  openAgentConversation,
  recordDrivenTabFor,
} from "@/modules/conversation";
import { createLogger, truncate } from "@/lib/logger";
import { defaultStartUrl } from "@/lib/prefs";
import { createWriteQueue } from "@/lib/storage";
import type { TabId } from "@/shared/types";

const log = createLogger("bridge");
const MUTATING = new Set([
  "navigate",
  "click",
  "type",
  "fill",
  "evaluate",
  "press_key",
  "scroll_down",
  "scroll_up",
]);

/** ponytail: idle clients release their slot after five minutes; a later action must start again. */
const IDLE_MS = 5 * 60_000;

/** Direct control shares the agent's tools, but owns only this client's run and browser claims. */
export class DirectSession {
  constructor(
    private readonly ownerId: string,
    private readonly onClose?: (run: ActiveRun) => void,
  ) {}

  private tabId: TabId | null = null;
  private unactedTabId: TabId | null = null;
  private starterTab = false;
  private sessionDriver: BrowserDriver | null = null;
  private claim: ActiveRun | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly serialize = createWriteQueue();

  get open(): boolean {
    return this.claim !== null;
  }

  get run(): ActiveRun | null {
    return this.claim;
  }

  get drivenTab(): TabId | null {
    return this.tabId;
  }

  start(
    goal: string,
    agent: string,
    where: { url?: string; background: boolean },
    conversationId: string,
  ): Promise<ToolResult> {
    return this.serialize(async () => {
      const acquired = acquireRun(conversationId, "bridge", this.ownerId);
      if (!acquired.ok) throw new Error(alreadyRunning(acquired.active));
      const run = acquired.run;
      this.claim = run;
      trackRunningRun(run, goal);
      try {
        const { tabId, opened, starter } = await this.pickTab(where, run);
        run.controller.signal.throwIfAborted();
        this.unactedTabId = opened ? tabId : null;
        this.starterTab = starter;
        this.sessionDriver = this.buildDriver(tabId, opened, run);
        await openAgentConversation(conversationId, agent);
        clearPendingQuestion(conversationId);
        await appendMessageTo(conversationId, {
          id: crypto.randomUUID(),
          role: "user",
          content: goal,
          timestamp: Date.now(),
        });
        run.controller.signal.throwIfAborted();
        await showAgentIndicator(tabId);
        const tab = await chrome.tabs.get(tabId);
        markRunningTab(run.id, tabId, tab.windowId);
        const result = await this.execute("snapshot", {});
        if (!result.ok) throw new Error(result.error ?? i18n.t("errors.noActiveTab"));
        run.controller.signal.throwIfAborted();
        this.touch();
        log.info("direct session opened", { ownerId: this.ownerId, task: truncate(goal, 120) });
        return result;
      } catch (error) {
        await this.cleanup();
        throw error;
      }
    });
  }

  act(tool: string, args: Record<string, unknown>, withSnapshot = true): Promise<ToolResult> {
    return this.serialize(async () => {
      const run = this.claim;
      if (!run || !this.sessionDriver) throw new Error(i18n.t("errors.noActiveTab"));
      run.controller.signal.throwIfAborted();
      this.clearIdle();
      try {
        const result = await this.execute(tool, args);
        if (run.controller.signal.aborted || !result.ok || !MUTATING.has(tool) || !withSnapshot) {
          return result;
        }
        const snapshot = await this.execute("snapshot", {}, false);
        return snapshot.ok
          ? { ...result, data: { ...asRecord(result.data), ...asRecord(snapshot.data) } }
          : result;
      } finally {
        if (!run.controller.signal.aborted) this.touch();
      }
    });
  }

  /** Stop signals now. Browser claims stay held until every in-flight action has settled. */
  abort(): void {
    this.claim?.controller.abort();
    this.clearIdle();
  }

  end(): Promise<void> {
    this.abort();
    return this.serialize(() => this.cleanup());
  }

  private async cleanup(): Promise<void> {
    const run = this.claim;
    if (!run) return;
    this.clearIdle();
    run.controller.abort();
    run.readsClosed = true;
    await Promise.allSettled([...run.pendingReads]);
    const tabId = this.tabId;
    const unusedStarter = this.starterTab ? this.unactedTabId : null;
    try {
      if (unusedStarter !== null) {
        await chrome.tabs.remove(unusedStarter).catch(() => {});
      } else if (tabId !== null) {
        await hideAgentIndicator(tabId).catch(() => {});
        await this.persistDrivenTab(run.conversationId, tabId);
      }
    } finally {
      try {
        await releaseBrowserOwner(run.id);
      } finally {
        this.claim = null;
        this.sessionDriver = null;
        this.tabId = null;
        this.unactedTabId = null;
        this.starterTab = false;
        releaseRun(run);
        this.onClose?.(run);
        log.info("direct session closed", { ownerId: this.ownerId, runId: run.id });
      }
    }
  }

  private async pickTab(
    where: { url?: string; background: boolean },
    run: ActiveRun,
  ): Promise<{ tabId: TabId; opened: boolean; starter: boolean }> {
    const adopt = async (tabId: TabId, loading: boolean, opened: boolean, starter = false) => {
      claimTab(run.id, tabId);
      this.tabId = tabId;
      this.unactedTabId = opened ? tabId : null;
      this.starterTab = starter;
      if (loading) await waitForLoad(tabId, opened ? 30_000 : 10_000);
      return { tabId, opened, starter };
    };
    if (!where.background && !where.url) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error(i18n.t("errors.noActiveTab"));
      if (isRestrictedUrl(tab.url)) throw new Error(i18n.t("errors.restrictedPage"));
      return adopt(tab.id, tab.status === "loading", false);
    }
    if (!where.url) {
      const { tabs } = await getThreadTabsFor(run.conversationId);
      const priorId = tabs[0]?.tabId;
      if (priorId !== undefined) {
        const tab = await chrome.tabs.get(priorId).catch(() => null);
        if (tab?.id !== undefined && !isRestrictedUrl(tab.url)) {
          return adopt(tab.id, tab.status === "loading", false);
        }
      }
    }
    const url = where.url || (await defaultStartUrl.get()) || defaultStartUrl.fallback;
    if (isRestrictedUrl(url)) throw new Error(i18n.t("errors.restrictedPage"));
    run.controller.signal.throwIfAborted();
    const tab = await chrome.tabs.create({ active: false, url });
    if (tab.id === undefined) throw new Error(i18n.t("errors.noActiveTab"));
    try {
      return await adopt(tab.id, true, true, !where.url);
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      this.unactedTabId = null;
      throw error;
    }
  }

  private async persistDrivenTab(conversationId: string, tabId: TabId): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        await recordDrivenTabFor(conversationId, { url: tab.url, title: tab.title ?? "", tabId });
      }
    } catch {
      // A closed tab has no page to resume.
    }
  }

  private buildDriver(initialTabId: TabId, opened: boolean, run: ActiveRun): BrowserDriver {
    return createDriver(initialTabId, {
      ownerId: run.id,
      openedTab: opened,
      onSwitch: async (tab) => {
        const previous = this.tabId;
        this.tabId = tab.id;
        if (this.unactedTabId !== null && this.unactedTabId !== tab.id) this.unactedTabId = null;
        if (previous !== null && previous !== tab.id) await hideAgentIndicator(previous);
        await showAgentIndicator(tab.id);
        markRunningTab(run.id, tab.id, tab.windowId);
      },
    });
  }

  private async execute(
    tool: string,
    args: Record<string, unknown>,
    record = true,
  ): Promise<ToolResult> {
    const run = this.claim;
    if (!run || !this.sessionDriver) throw new Error(i18n.t("errors.noActiveTab"));
    run.controller.signal.throwIfAborted();
    const result = await executeTool(
      { id: crypto.randomUUID(), name: tool, args },
      this.sessionDriver,
      { signal: run.controller.signal },
    );
    if (result.ok && MUTATING.has(tool)) this.unactedTabId = null;
    if (record) {
      const detail = formatDetail(tool, result, args);
      await appendMessageTo(run.conversationId, {
        id: crypto.randomUUID(),
        role: "step",
        tool,
        content: result.ok
          ? formatSuccessSummary(tool, result.data)
          : i18n.t("errors.failed", { error: result.error }),
        args,
        ok: result.ok,
        timestamp: Date.now(),
        ...(detail ? { detail } : {}),
      });
    }
    return result;
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private touch(): void {
    this.clearIdle();
    this.idle = setTimeout(() => {
      void this.end().catch((error: unknown) => log.warn("direct cleanup failed", String(error)));
    }, IDLE_MS);
  }
}

function alreadyRunning(run: ActiveRun): string {
  return run.owner === "panel"
    ? i18n.t("errors.alreadyRunningPanel")
    : i18n.t("errors.alreadyRunningMCP");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
