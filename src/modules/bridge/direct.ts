import { i18n } from "@/i18n";
import { acquireRun, getActiveRun, releaseRun } from "@/modules/agent/active-runs";
import type { ActiveRun } from "@/modules/agent/active-runs";
import { executeTool, formatDetail, formatSuccessSummary } from "@/modules/agent/tools";
import type { ToolResult } from "@/modules/agent/tools";
import {
  createDriver,
  detachAll,
  hideAgentIndicator,
  isRestrictedUrl,
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
import type { TabId } from "@/shared/types";
import { bridgeThread } from "./config";

const log = createLogger("bridge");

/**
 * Direct browser control, for an external agent that would rather drive than
 * delegate: it calls snapshot/click/type itself instead of handing TabRunner a
 * task. Every verb goes through the same `executeTool` the agent loop uses, so
 * there is exactly one browser implementation and no second catalog to drift.
 *
 * What a direct session does NOT get is the agent loop, and with it the
 * consequential-action policy — that lives in TabRunner's system prompt, which
 * no longer sits between the client and the page. The client carries the rule
 * instead (the MCP tool descriptions and the skill say so), and the session is
 * loud about it: the on-page badge and favicon dot are up the whole time, and
 * every action lands in a stored transcript the user can read afterwards.
 *
 * A session holds the single run slot, so direct driving and an agent run can
 * never fight over the same tab — whoever asks second is told where the other
 * one is.
 */

/** Actions that change the page, and therefore invalidate every existing ref. */
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

/**
 * ponytail: a session left open would hold the run slot against the panel
 * forever, so it expires on its own. The ceiling is that a client pausing more
 * than this between actions finds its session closed and must start again;
 * worker suspension also drops the timer, but that clears the slot too, so it
 * fails safe.
 */
const IDLE_MS = 5 * 60_000;

export class DirectSession {
  /**
   * Fired whenever a session actually closes — end, stop, expiry. The bridge
   * uses it to clear its "an external agent is driving" state, so an idle
   * session timing out can't leave the panel claiming the browser is busy.
   */
  constructor(private readonly onClose?: () => void) {}

  private conversationId: string | null = null;
  private tabId: TabId | null = null;
  /** The tab this session opened at start, until a mutating action or switch uses/abandons it. */
  private unactedTabId: TabId | null = null;
  /** True when the opened tab started on the default start page rather than an explicit URL. */
  private starterTab = false;
  /** The last tab a session actually drove, reused by the next browser_start when no URL is given. */
  private lastTabId: TabId | null = null;
  private sessionDriver: BrowserDriver | null = null;
  private claim: ActiveRun | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;

  get open(): boolean {
    return this.claim !== null;
  }

  /** The tab being driven, so a screenshot can say whether it caught it. */
  get drivenTab(): TabId | null {
    return this.tabId;
  }

  /**
   * Opens a session. Like `run`, it works a tab of its own by default (reusing
   * the bridge's last driven tab while it lives, else opening `url` or the
   * start page) and leaves the page the user is reading alone: its snapshot
   * goes to the client, and a client that was never told which page that is
   * should not be handed it. `background: false` is the opt-in for a task that
   * is about what the user is looking at. The goal is written as the thread's
   * first message, which makes it the conversation's title — a stated goal is a
   * subject, so each session gets its own thread rather than appending to a
   * previous one whose heading would then be a lie.
   */
  async start(
    goal: string,
    agent: string,
    where: { url?: string; background: boolean },
  ): Promise<ToolResult> {
    const active = getActiveRun();
    if (active) throw new Error(alreadyRunning(active));

    const { tabId, opened, starter } = await this.pickTab(where);

    const claim = acquireRun(crypto.randomUUID(), "bridge");
    if (!claim.ok) {
      if (opened) void chrome.tabs.remove(tabId).catch(() => {});
      throw new Error(alreadyRunning(claim.active));
    }

    this.claim = claim.run;
    this.tabId = tabId;
    this.unactedTabId = opened ? tabId : null;
    this.starterTab = starter;
    this.sessionDriver = this.buildDriver(tabId, opened);
    this.conversationId = claim.run.conversationId;
    await openAgentConversation(this.conversationId, agent);
    await appendMessageTo(this.conversationId, {
      id: crypto.randomUUID(),
      role: "user",
      content: goal,
      timestamp: Date.now(),
    });

    log.info("direct session opened", { agent, task: truncate(goal, 120) });
    void showAgentIndicator(tabId);
    this.touch();
    // The opening snapshot: a session's first move is always to look, so
    // handing it back here saves a round trip and gives the client its refs.
    return this.run("snapshot", {});
  }

  /**
   * Runs one tool against the driven tab and records it. Mutating actions come
   * back with a fresh snapshot attached: every ref belongs to the snapshot that
   * produced it, so acting on stale refs is a correctness bug, not a slow path.
   * A client that does not want the page back (a snapshot is thousands of
   * tokens) says so, and then owns the staleness: it snapshots before its next
   * ref.
   */
  async act(tool: string, args: Record<string, unknown>, withSnapshot = true): Promise<ToolResult> {
    if (!this.claim || this.tabId === null) {
      throw new Error(
        "No direct session is open. Call browser_start with what you're trying to do, then drive.",
      );
    }
    this.touch();
    const result = await this.run(tool, args);
    if (!result.ok || !MUTATING.has(tool) || !withSnapshot) return result;

    const snapshot = await this.run("snapshot", {}, { record: false });
    if (!snapshot.ok) return result;
    return { ...result, data: { ...asRecord(result.data), ...asRecord(snapshot.data) } };
  }

  /** Closes the session: releases the slot, drops the marks, ends the thread. */
  async end(): Promise<void> {
    if (!this.claim) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    releaseRun(this.claim);
    this.claim = null;
    this.sessionDriver = null;
    const tabId = this.tabId;
    this.tabId = null;
    const conversationId = this.conversationId;
    this.conversationId = null;
    const unusedStarter = this.starterTab && this.unactedTabId !== null ? this.unactedTabId : null;
    this.unactedTabId = null;
    this.starterTab = false;
    log.info("direct session closed");
    if (unusedStarter !== null) {
      void chrome.tabs.remove(unusedStarter).catch(() => {});
    } else if (tabId !== null) {
      this.lastTabId = tabId;
      await hideAgentIndicator(tabId);
      void this.persistDrivenTab(conversationId, tabId);
    }
    // Same rule as an agent run: the debugger leaves with the session, or its
    // "debugging this browser" infobar would outstay the work it came for.
    await detachAll();
    this.onClose?.();
  }

  /** Closes any open session and forgets the tab it drove (for new_conversation). */
  async reset(): Promise<void> {
    await this.end();
    this.lastTabId = null;
  }

  /**
   * Seeds a newly minted bridge thread with the tab a preceding direct session
   * already worked on, so `browser_start` followed by `run` continues in that
   * tab instead of opening a fresh start-page tab.
   */
  async seedThreadTab(conversationId: string): Promise<void> {
    if (this.lastTabId === null) return;
    const { tabs } = await getThreadTabsFor(conversationId);
    if (tabs.length > 0) return;
    await this.persistDrivenTab(conversationId, this.lastTabId);
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** The tab a session drives: its own background tab, or the one the user is on. */
  private async pickTab(where: {
    url?: string;
    background: boolean;
  }): Promise<{ tabId: TabId; opened: boolean; starter: boolean }> {
    // A URL names its own page, so it never adopts — the same rule `run` follows.
    if (!where.background && !where.url) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(i18n.t("errors.noActiveTab"));
      // Refuse a page injection could never reach before claiming the slot, and
      // give a still-loading page its chance to settle first.
      if (isRestrictedUrl(tab.url)) throw new Error(i18n.t("errors.restrictedPage"));
      if (tab.status === "loading") await waitForLoad(tab.id, 10_000);
      return { tabId: tab.id, opened: false, starter: false };
    }

    // Continue on the tab an earlier bridge session or run already worked in
    // while it still lives, instead of minting a fresh start-page tab every time.
    if (!where.url) {
      const priorId = await this.priorTabId();
      if (priorId !== null) {
        try {
          const tab = await chrome.tabs.get(priorId);
          if (tab?.id && !isRestrictedUrl(tab.url)) {
            if (tab.status === "loading") await waitForLoad(tab.id, 10_000);
            return { tabId: tab.id, opened: false, starter: false };
          }
        } catch {
          // The tab was closed since the last session — open a fresh one below.
        }
        this.lastTabId = null;
      }
    }

    const url = where.url || (await defaultStartUrl.get()) || defaultStartUrl.fallback;
    if (isRestrictedUrl(url)) throw new Error(i18n.t("errors.restrictedPage"));
    const created = await chrome.tabs.create({ active: false, url });
    if (!created.id) throw new Error(i18n.t("errors.noActiveTab"));
    try {
      await waitForLoad(created.id);
    } catch (e) {
      // A tab the session never drove is litter.
      void chrome.tabs.remove(created.id).catch(() => {});
      throw e;
    }
    return { tabId: created.id, opened: true, starter: !where.url };
  }

  private async priorTabId(): Promise<TabId | null> {
    if (this.lastTabId !== null) return this.lastTabId;
    const threadId = await bridgeThread.get();
    if (!threadId) return null;
    const { tabs } = await getThreadTabsFor(threadId);
    return tabs[0]?.tabId ?? null;
  }

  private async persistDrivenTab(conversationId: string | null, tabId: TabId): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return;
      const entry = { url: tab.url, title: tab.title ?? "", tabId };
      if (conversationId) await recordDrivenTabFor(conversationId, entry);
      const threadId = await bridgeThread.get();
      if (threadId && threadId !== conversationId) await recordDrivenTabFor(threadId, entry);
    } catch {
      // The tab died or tabs.get is unavailable in unit tests — nothing to record.
    }
  }

  /** One tool call against the current tab, optionally written to the thread. */
  private async run(
    tool: string,
    args: Record<string, unknown>,
    opts: { record?: boolean } = {},
  ): Promise<ToolResult> {
    if (!this.sessionDriver) throw new Error(i18n.t("errors.noActiveTab"));
    const result = await executeTool(
      { id: crypto.randomUUID(), name: tool, args },
      this.sessionDriver,
    );
    if (result.ok) {
      if (MUTATING.has(tool)) {
        this.unactedTabId = null;
      } else if (tool === "switch_tab") {
        const nextId =
          (result.data as { id?: number } | undefined)?.id ??
          (typeof args.tab_id === "number" ? args.tab_id : undefined);
        if (nextId !== undefined && nextId !== this.tabId) {
          const prev = this.tabId;
          this.tabId = nextId;
          if (prev !== null) void hideAgentIndicator(prev);
          void showAgentIndicator(nextId);
        }
        if (this.unactedTabId !== null && this.unactedTabId !== this.tabId) {
          const abandoned = this.unactedTabId;
          this.unactedTabId = null;
          void chrome.tabs.remove(abandoned).catch(() => {});
        }
      }
    }
    if (opts.record !== false) await this.record(tool, args, result);
    return result;
  }

  private buildDriver(initialTabId: TabId, opened: boolean): BrowserDriver {
    return createDriver(initialTabId, {
      openedTab: opened,
      onSwitch: (tab) => {
        const prev = this.tabId;
        this.tabId = tab.id;
        if (this.unactedTabId !== null && this.unactedTabId !== tab.id) {
          // createDriver's switchTab closes the abandoned starter tab itself;
          // clear our handle so run() does not remove it a second time.
          this.unactedTabId = null;
        }
        if (prev !== null && prev !== tab.id) void hideAgentIndicator(prev);
        void showAgentIndicator(tab.id);
      },
    });
  }

  /** The step row, worded exactly as the agent loop words its own. */
  private async record(
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    if (!this.conversationId) return;
    const detail = formatDetail(tool, result, args);
    await appendMessageTo(this.conversationId, {
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

  /** Restarts the idle countdown — an active session never expires under itself. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      log.info("direct session expired");
      void this.end();
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
