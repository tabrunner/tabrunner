import { initI18n, i18n } from "@/i18n";
import { startAgentRun, MEMORY_KEEPALIVE_ALARM } from "@/modules/agent/start-run";
import { recoverInterrupted } from "@/modules/walkthrough";
import { getActiveRun, releaseRun, answerPlanApproval } from "@/modules/agent/active-runs";
import {
  cancelQueued,
  currentBoard,
  listQueue,
  onBoardChanged,
  restorePendingQuestion,
  runBoardItem,
  submitRun,
} from "@/modules/agent/run-queue";
import type { RunBoard } from "@/modules/agent/run-queue";
import { appendMessageTo, getActiveId, getConversationMeta } from "@/modules/conversation";
import { setActiveConversation } from "@/modules/conversation/conversations";
import { TranscriptWriter } from "@/modules/conversation/transcript";
import { hideAgentIndicator, refreshAgentIndicator, syncActionBadge } from "@/modules/browser";
import {
  reconcileStatusWidgets,
  refreshStatusWidget,
  sweepStatusWidget,
  syncStatusWidget,
} from "@/modules/browser/status-widget";
import type { WidgetState } from "@/modules/browser/status-widget";
import { widgetHidden, widgetResetV1 } from "@/lib/prefs";
import { initProviderOriginStrip } from "@/modules/providers/origin";
import {
  createProvider,
  ensureProviderCredential,
  getActiveProvider,
  resolveProviderModel,
} from "@/modules/providers";
import { compactConversation } from "@/modules/agent/compact";
import { createLogger, truncate } from "@/lib/logger";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { getBridge, startBridge } from "@/modules/bridge";
import { isScheduleAlarm } from "@/modules/schedule";
import { onScheduleAlarm, runScheduleNow, startScheduler } from "@/modules/schedule/scheduler";

const log = createLogger("bg");
/**
 * Every open panel — an external agent starting work must reach them all —
 * mapped to the window it lives in (its `hello`, undefined until that lands).
 * The window matters: notifications are gated on whether the user can see the
 * panel, and "a panel is open" plus "a window is focused" can be two facts
 * about two different windows.
 */
const panelPorts = new Map<chrome.runtime.Port, number | undefined>();
/** Wakes the worker through long provider silences while a run is up and the
 *  panel (whose ping does this when open) is closed. */
const KEEPALIVE_ALARM = "tabrunner-run-keepalive";
/** Where each notification's click should land, by notification id. */
const notificationTargets = new Map<string, { conversationId: string; tabId?: number }>();
/** Runs the user stopped themselves — their done is not notification-worthy. */
const stoppedByUser = new Set<string>();
/**
 * A run failed while nobody was watching. The board empties the moment a run
 * ends, so the count badge that carried it is gone one tick later and the
 * toolbar goes back to looking idle — the exact opposite of what happened. This
 * keeps a red "!" up until a panel opens, so a failure you were away for is
 * still on screen when you come back. The OS notification is the other half;
 * it can be dismissed, missed, or switched off at the system level.
 */
let unseenFailure = false;
/** The widget's current content — repaints after navigation read it. */
let widgetState: WidgetState | null = null;

export default defineBackground(() => {
  void initI18n();
  // The toolbar click opens the panel from the browser process — never from a
  // listener here. An action.onClicked handler would park the click behind a
  // cold worker start (this whole bundle evaluated before the event even
  // dispatches), which read as "the panel takes seconds to open".
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // A worker killed mid-extraction leaves its keepalive alarm firing forever —
  // a permanent wake loop. Alarms outlive the worker, so clear a stale one here.
  void chrome.alarms.clear(MEMORY_KEEPALIVE_ALARM);
  // Badges live in the browser process, so they outlive the worker that set
  // one. A restart holds no runs — clear it before anything else paints.
  void syncActionBadge(0);
  // Strip Origin from our own provider calls, or a subscription OAuth token is
  // refused by Anthropic's CORS gate before any model code ever runs.
  initProviderOriginStrip();
  // A walkthrough still marked "recording" outlived the worker that was
  // writing it: its frames are all on disk, so it becomes an honest "partial"
  // rather than a ghost the viewer would draw as still in progress.
  void recoverInterrupted();
  // A restarted worker holds no runs — the ones the stored board names died
  // with the old worker. Reset it, sweep any orphaned widget pills and
  // indicator marks, and say in each waiting thread that its task died with
  // the worker rather than vanishing silently. A parked ask_user is not a run —
  // the answer is still owed across the restart, so its record is restored, not
  // reset, or the ambient "answer needed" would drop exactly when it matters.
  void runBoardItem.get().then(async (stale) => {
    if (stale.pendingQuestion) restorePendingQuestion(stale.pendingQuestion);
    if (!stale.running && stale.queue.length === 0) return;
    for (const q of stale.queue) {
      void appendMessageTo(q.conversationId, {
        id: crypto.randomUUID(),
        role: "step",
        tool: "interrupted",
        content: i18n.t("errors.runCancelled"),
        timestamp: Date.now(),
      });
    }
    if (stale.running?.tabId !== undefined) void hideAgentIndicator(stale.running.tabId);
    await runBoardItem.set({
      queue: [],
      ...(stale.pendingQuestion ? { pendingQuestion: stale.pendingQuestion } : {}),
    });
    void sweepStatusWidget();
  });
  // The MCP bridge — a WS client to the local daemon so external AI clients can
  // drive the same loop. Reconnects on its own reconcile alarm; harmless when
  // no daemon is listening. Activity changes are broadcast to open panels: the
  // run is already blinking the driven tab's favicon, the panel just names it.
  startBridge((active) => {
    for (const p of panelPorts.keys()) send(p, { type: "run_active", active });
  });

  // Both ambient surfaces follow the run board. The toolbar badge is the floor
  // — never injected, never suppressed, so "is it still running?" always has an
  // answer. The floating widget is the richer, best-effort one: each window's
  // active tab (never the driven tab, which has the indicator) while TabRunner
  // has work, gone when idle, suppressed by the hide pref. The same transitions
  // drive the keepalive: a run with a closed panel has no ping to hold the
  // worker up through a long provider silence.
  // The pill now defaults ON — under adoption the driven tab is usually yours,
  // so the pill is the primary "is it still running?" marker when you switch
  // away. Reset a stored "hide" ONCE so the new default reaches everyone; the
  // MV3 worker restarts constantly, so gate it behind a versioned flag or the
  // user's setting is wiped on every boot.
  void widgetResetV1.get().then((done) => {
    if (!done) void widgetHidden.remove().then(() => widgetResetV1.set(true));
  });

  onBoardChanged((board) => {
    paintActionBadge(board);
    widgetState = boardToWidget(board);
    const exclude = board.running?.tabId;
    void widgetHidden
      .get()
      .then((hidden) => syncStatusWidget(hidden ? null : widgetState, exclude));
    if (board.running || board.queue.length > 0) {
      void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    } else {
      void chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  });
  widgetHidden.watch((hidden) => {
    void syncStatusWidget(hidden ? null : widgetState, currentBoard().running?.tabId);
  });
  // Scheduled tasks: alarms outlive the worker but NOT every extension update,
  // so storage is the truth and this re-arms from it at every boot. The two
  // hooks are the surfaces the scheduler has no business owning — a run that
  // fires at 3am is unwatched by definition, so its ending has to reach out.
  void startScheduler({
    onRunEnded: (conversationId, task, event) => void notifyRunEnded(conversationId, task, event),
    onAskUser: (conversationId, question, choices) =>
      void notifyIfAway("tabrunner-question", question, conversationId, choices),
  });

  // Most alarms exist only to fire — the wake itself resets the MV3 idle timer,
  // which is what the keepalive and bridge-reconcile alarms are for. A schedule
  // alarm is the one that carries work.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (isScheduleAlarm(alarm.name)) onScheduleAlarm(alarm.name);
  });
  log.debug("background initialized");

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    log.debug("side panel connected");
    panelPorts.set(port, undefined);
    // The panel is open: whatever failed while you were away is about to be on
    // screen (the transcript kept it), so the toolbar stops shouting about it.
    if (unseenFailure) {
      unseenFailure = false;
      paintActionBadge();
    }

    port.onMessage.addListener(async (msg: Command) => {
      switch (msg.type) {
        case "hello": {
          panelPorts.set(port, msg.windowId);
          break;
        }

        case "run": {
          // The panel stored its task message (and adopted the conversation)
          // before the run command left — the id rides the command, so this
          // run's transcript lands exactly where its message did.
          const conversationId = msg.conversationId;
          const launch = () => {
            // Persistence lives here, not in the panel store: the panel closes
            // itself after submit, and its writer would die with it.
            const writer = new TranscriptWriter(conversationId);
            // submitRun launched this with the slot already free — acquireRun
            // inside startAgentRun is the same synchronous turn, so no
            // already-running branch is reachable here.
            void startAgentRun({
              conversationId,
              owner: "panel",
              task: msg.task,
              images: msg.images,
              thisPage: msg.thisPage,
              emit: (event) => {
                writer.apply(event);
                send(port, event);
                if (event.type === "done" || event.type === "error") {
                  void notifyRunEnded(conversationId, msg.task, event);
                }
              },
              onAskUser: (question, choices) =>
                void notifyIfAway("tabrunner-question", question, conversationId, choices),
              onPlanApprovalRequest: (steps, reapproval) =>
                void notifyPlanParked(conversationId, steps, reapproval),
            }).catch((e) => {
              log.error("panel run failed to start:", e instanceof Error ? e.message : String(e));
            });
          };
          const outcome = submitRun({ conversationId, owner: "panel", task: msg.task, launch });
          if ("queued" in outcome) {
            send(port, { type: "run_queued", id: outcome.id, position: outcome.queued });
          }
          break;
        }

        case "cancel_queued": {
          // Anything but the bridge's own: an external client owns its runs and
          // has its own stop path, but a scheduled fire waiting behind the
          // user's work is theirs to wave off — skipping one fire leaves the
          // schedule itself standing, already armed for the next.
          const entry = listQueue().find((q) => q.id === msg.id && q.owner !== "bridge");
          if (entry && cancelQueued(msg.id)) {
            // A cancelled queued run never produces an event — leave the
            // breadcrumb, or the thread reads as if the task vanished.
            void appendMessageTo(entry.conversationId, {
              id: crypto.randomUUID(),
              role: "step",
              tool: "interrupted",
              content: i18n.t("errors.runCancelled"),
              timestamp: Date.now(),
            });
          }
          break;
        }

        case "inject": {
          // Only meaningful mid-run; the panel routes idle-time input to `run`.
          const run = getActiveRun();
          if (run?.owner === "panel") run.injectedQueue.push({ id: msg.id, text: msg.text });
          break;
        }

        case "unqueue": {
          const run = getActiveRun();
          if (run?.owner !== "panel") break;
          const i = run.injectedQueue.findIndex((q) => q.id === msg.id);
          if (i >= 0) run.injectedQueue.splice(i, 1);
          break;
        }

        case "plan_approval": {
          // The user's answer to a parked plan prompt — resolves the loop's wait.
          // Owner-scoped like stop: a bridge run never parks, so this is a no-op there.
          chrome.notifications.clear("tabrunner-plan");
          // The gate is answered — a mid-run replan is a fresh ask and gets its
          // own notification, so release the one-buzz-per-park hold.
          notifiedPlanFor = null;
          if (getActiveRun()?.owner === "panel") answerPlanApproval(msg.approved, msg.feedback);
          break;
        }

        case "stop": {
          const run = getActiveRun();
          // The panel's Stop on an external run — the same mechanics as the
          // bridge's own stop, routed here so the user can reclaim the browser.
          if (run?.owner === "bridge") getBridge()?.stopFromPanel();
          else haltRun(run);
          // Flush the partial stream immediately — the loop's own done arrives
          // as it unwinds and is a harmless no-op in the panel.
          send(port, { type: "done" });
          break;
        }

        case "query_run": {
          // Answer fresh on connect — the broadcast may have happened while the
          // panel was closed, and stale state must never read as "browser idle".
          send(port, { type: "run_active", active: getBridge()?.activity ?? null });
          // A panel that reopened mid-run missed the driving event the run fired
          // at start, so its live band had no tab chip and no way back to the
          // page. Re-send it from the board: the band is then whole either way,
          // which is what lets the run strip stop repeating it.
          await sendDrivingTo(port);
          // Re-arm a plan the panel was closed on. The approval card lives only
          // in panel memory, so a run parked while the panel was away — which
          // is every run whose notification the user just clicked — would come
          // back unanswerable: a question on screen with no way to say yes.
          const parked = getActiveRun();
          if (parked?.owner === "panel" && (await getActiveId()) === parked.conversationId) {
            if (parked.planApproval) {
              const { steps, reapproval } = parked.planApproval;
              send(port, { type: "plan_approval", steps, reapproval });
            }
            // Same reason as the plan card above: the queue is the worker's,
            // its cards are the panel's. Without this the steers still land
            // while the composer shows nothing to cancel.
            if (parked.injectedQueue.length > 0) {
              send(port, { type: "queued_steers", items: [...parked.injectedQueue] });
            }
          }
          break;
        }

        case "compact": {
          // The worker owns transcript writes, so it owns this: the panel can
          // close mid-summarization and the summary still lands.
          const conversationId = await getActiveId();
          if (!conversationId) {
            send(port, {
              type: "compact_failed",
              message: i18n.t("commands.compact.nothing"),
              nothing: true,
            });
            break;
          }
          // The authoritative busy check — the panel refuses locally too, but it
          // only knows its OWN status: a panel reopened onto a background run of
          // its own reads idle, and a summary appended under a live run lands
          // after messages that run is still writing.
          if (getActiveRun()?.conversationId === conversationId) {
            send(port, {
              type: "compact_failed",
              message: i18n.t("commands.compact.busy"),
              nothing: true,
            });
            break;
          }
          try {
            // A summary is written into this thread's transcript, so it is
            // written by this thread's engine — not whatever is picked now.
            const config = await getProviderFor(
              (await getConversationMeta(conversationId))?.engine,
            );
            if (!config) throw new Error(i18n.t("chat.hint.noProvider"));
            const resolved = await resolveProviderModel(await ensureProviderCredential(config));
            const result = await compactConversation(
              createProvider(resolved),
              conversationId,
              // Nothing cancels a compaction: it is one short call, and the
              // panel that asked for it may already be gone.
              new AbortController().signal,
            );
            send(
              port,
              result
                ? { type: "compacted", ...result }
                : {
                    type: "compact_failed",
                    message: i18n.t("commands.compact.nothing"),
                    nothing: true,
                  },
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log.warn("compact failed:", message);
            send(port, { type: "compact_failed", message });
          }
          break;
        }

        case "ping": {
          // Heartbeat from the panel — receiving it keeps the worker alive
          // through long provider silences (reasoning models) and slow tools.
          break;
        }
      }
    });

    // Runs survive the panel closing — dispatch-and-forget is the whole point.
    // A run is stopped explicitly (panel, widget, MCP stop, driven-tab close),
    // never by the disconnect.
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
      log.debug("side panel disconnected");
      // Closing the panel is one of the two ways to stop watching a parked run
      // — see notifyParkedRun for the other.
      notifyParkedRun();
    });
  });

  // A click on either on-page mark — the floating pill or the driven tab's
  // badge — posted from the page's isolated world ("hide" collapses the pill
  // in-page and never reaches the worker).
  chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : null;
    // Settings' "Run now". Runs live in the worker — the options page is a
    // separate context with no run slot, no driver and no board, so the button
    // asks rather than calls.
    if (m?.type === "tabrunner-run-schedule" && typeof m.id === "string") {
      runScheduleNow(m.id);
      return;
    }
    // Deleting a schedule while its run is in flight. "Delete this" means make
    // it stop — a schedule removed from the list while its run keeps driving
    // the browser is the worst kind of surprise, so the record and the run in
    // progress go together.
    if (m?.type === "tabrunner-stop-run" && typeof m.conversationId === "string") {
      const run = getActiveRun();
      if (run?.conversationId === m.conversationId) haltRun(run);
      return;
    }
    if (m?.type !== "tabrunner-mark" || m.action !== "open") return;
    // Land on the work, not on whatever conversation happens to be active.
    const board = currentBoard();
    const target = board.running?.conversationId ?? board.queue[0]?.conversationId;
    if (target) void setActiveConversation(target);
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) void chrome.sidePanel.open({ windowId });
  });

  // A load wipes the badge, the favicon dot, and the status widget. The
  // navigate tool repaints itself, but click-triggered navigations have no
  // other hook — any load completing in a marked tab puts its marks back.
  // No-ops for every other tab.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "complete") return;
    void refreshAgentIndicator(tabId);
    if (widgetState) void refreshStatusWidget(tabId, widgetState);
  });

  // The widget lives on each window's active tab: activation and focus churn
  // move it there and pull it from tabs that lost activation.
  chrome.tabs.onActivated.addListener(() => void reconcileStatusWidgets());
  chrome.windows.onFocusChanged.addListener(() => {
    void reconcileStatusWidgets();
    // Leaving the browser (or moving to a window with no panel) is the other
    // way to stop watching a parked run — see notifyParkedRun.
    notifyParkedRun();
  });
});

/**
 * End a run the user asked to end. Covers the panel's own and a scheduled one:
 * nobody asked for a schedule's fire just now, so every surface that can see it
 * has to be able to stop it — a run on the board with no way out is the dead end
 * the rest of this file is written to avoid. Stopping a fire never cancels the
 * standing schedule; that is Settings' Delete.
 *
 * A bridge run is not ours to abort (it has its own stop path) and is handled by
 * the caller. Returns whether anything was stopped.
 */
function haltRun(run: ReturnType<typeof getActiveRun>): boolean {
  if (run?.owner !== "panel" && run?.owner !== "schedule") return false;
  // User-initiated — the run's done must not fire a notification.
  stoppedByUser.add(run.conversationId);
  run.controller.abort();
  run.injectedQueue.length = 0;
  releaseRun(run);
  return true;
}

function send(port: chrome.runtime.Port, event: Event) {
  try {
    port.postMessage(event);
  } catch {
    // Port closed
  }
}

/**
 * Tell a freshly connected panel which tab the run it reopened into is driving
 * — the `driving` event it was not around to receive. Only for a run on the
 * panel's own open conversation: the chip belongs to the band, and the band
 * only speaks for the thread on screen.
 */
async function sendDrivingTo(port: chrome.runtime.Port): Promise<void> {
  const running = currentBoard().running;
  if (!running || running.tabId === undefined) return;
  if (running.conversationId !== (await getActiveId())) return;
  try {
    const tab = await chrome.tabs.get(running.tabId);
    send(port, {
      type: "driving",
      tabId: running.tabId,
      windowId: tab.windowId,
      title: tab.title ?? "",
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    });
  } catch {
    // The driven tab is gone — the run's own error is on its way.
  }
}

/** The widget's content for a board — null when there is nothing to report.
 *  With only a queue (e.g. waiting behind a direct session) the first waiter
 *  leads the pill. An unanswered question outlives its run: the slot is free,
 *  but the answer is still owed, so the pill stays up awaiting — dispatch-and-
 *  forget must never swallow the one thing the user has to say. */
function boardToWidget(board: RunBoard): WidgetState | null {
  const lead = board.running ?? board.queue[0];
  if (!lead) {
    if (!board.pendingQuestion) return null;
    return {
      // The question itself leads — it is the ask, more informative than a
      // generic "waiting" line. The "?" badge carries the blocked state.
      task: truncate(board.pendingQuestion.question, 120),
      queuedText: "",
      awaiting: true,
      awaitingText: "",
      hideLabel: i18n.t("widget.hide"),
      openHint: i18n.t("widget.openHint"),
      hideHint: i18n.t("widget.hideHint"),
      expandHint: i18n.t("widget.expandHint"),
    };
  }
  const extra = board.running ? board.queue.length : board.queue.length - 1;
  const parked = board.running?.awaiting === true;
  return {
    task: truncate(lead.task, 120),
    queuedText: extra > 0 ? i18n.t("widget.queued", { count: extra }) : "",
    awaiting: parked,
    // A parked run's task excerpt can't say the run is blocked on you — swap
    // the text for the state (the excerpt stays on the tooltip).
    awaitingText: parked ? i18n.t("run.awaitingApproval") : "",
    hideLabel: i18n.t("widget.hide"),
    openHint: i18n.t("widget.openHint"),
    hideHint: i18n.t("widget.hideHint"),
    expandHint: i18n.t("widget.expandHint"),
  };
}

/** The toolbar's one line: what is running, what failed, or what still needs an answer. */
function paintActionBadge(board: RunBoard = currentBoard()): void {
  void syncActionBadge(
    (board.running ? 1 : 0) + board.queue.length + (board.pendingQuestion ? 1 : 0),
    {
      awaiting: board.running?.awaiting === true || board.pendingQuestion != null,
      failed: unseenFailure,
      recording: board.running?.recording === true,
    },
  );
}

/**
 * Is the user actually looking at TabRunner? An open panel is not enough: a
 * side panel behind the editor you are working in is as unseen as a closed one,
 * and "it errored an hour ago" is the thing dispatch-and-forget must never say.
 * So the browser has to be the frontmost app too — and the panel has to be open
 * in the window that has focus. Those last two are separate facts: a panel open
 * in window A while you work in window B is on nobody's screen, and taking "a
 * panel exists" for "you can see it" drops the notification silently.
 */
async function userIsWatching(): Promise<boolean> {
  if (panelPorts.size === 0) return false;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.focused !== true) return false;
    // A port that has not said hello yet counts as watching: the gap is one
    // message wide, and over-suppressing costs a late notification while
    // under-suppressing buzzes about something already on screen.
    return [...panelPorts.values()].some((id) => id === undefined || id === win.id);
  } catch {
    // Can't tell — an open panel is the better guess than a duplicate ping.
    return true;
  }
}

/**
 * Dispatch-and-forget means the panel is usually closed when a run ends — say
 * so where the user actually is. The question/plan notifications have their own
 * flow (notifyIfAway); this covers the otherwise-silent finishes. Skipped for
 * endings that were the user's own doing (stop, driven-tab close) and for
 * question endings, which already fired their own notification. Per-run ids,
 * so a second finishing run never replaces the first's notification.
 */
async function notifyRunEnded(conversationId: string, task: string, event: Event): Promise<void> {
  // The plan gate died with the run, so its notification must not outlive it —
  // clicking a stale "Approve this plan?" opens the panel on a conversation
  // with no card to answer, the dead end every error state here is written to
  // avoid. Cleared ahead of the early returns below on purpose: a silent error
  // (the driven tab closed under a parked plan) and a user stop are exactly the
  // endings that leave one behind.
  chrome.notifications.clear("tabrunner-plan");
  notifiedPlanFor = null;
  if (event.type === "done" && event.question) return;
  if (event.type === "error" && event.silent) return;
  if (stoppedByUser.delete(conversationId)) return;
  // Read before the first await: the run releases its slot moments after this
  // event, and the board's tab id goes with it.
  const tabId = currentBoard().running?.tabId;
  const done = event.type === "done";
  const watching = await userIsWatching();
  // A failure nobody saw outlives its notification — the toolbar holds it.
  // "Nobody saw it" is about the CONVERSATION, not the app: a panel open on
  // another chat is as blind to a run failing over here as a closed one, and a
  // scheduled run is on another chat by construction. Without this, the one
  // ending the user most needs to know about is also the quietest.
  if (!done && !(watching && (await getActiveId()) === conversationId)) {
    unseenFailure = true;
    paintActionBadge();
  }
  // The OS notification stays gated on the app itself — buzzing the desktop of
  // someone already using TabRunner is noise the toolbar mark covers better.
  if (watching) return;
  const id = `tabrunner-run-${conversationId}`;
  notificationTargets.set(id, { conversationId, ...(tabId !== undefined ? { tabId } : {}) });
  try {
    void chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icon/128.png",
      title: truncate(task, 80),
      message: truncate(
        done
          ? (event.summary ?? i18n.t("notify.doneFallback"))
          : event.type === "error"
            ? event.message
            : "",
        256,
      ),
    });
  } catch {
    // Notifications can fail silently — the widget still carries the signal.
  }
}

/**
 * Fires an OS notification when a run needs the user and nobody is watching a
 * panel that could show it — an unanswered ask_user or a parked plan approval
 * stalls silently otherwise, and the strip mark is invisible from another app.
 * A question's choices ride in the message so the ask is actionable even from
 * here. Returns whether it actually fired, so a caller holding a one-buzz-per-
 * ask latch only arms it when there is something out there to be seen.
 */
async function notifyIfAway(
  id: string,
  message: string,
  conversationId?: string,
  choices?: string[],
): Promise<boolean> {
  if (await userIsWatching()) return false;
  if (conversationId) notificationTargets.set(id, { conversationId });
  const body = choices?.length ? `${message} — ${choices.join(" · ")}` : message;
  try {
    void chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icon/128.png",
      title: "TabRunner",
      message: truncate(body, 256),
    });
    return true;
  } catch {
    // Notifications can fail silently — the strip mark still carries the signal.
    return false;
  }
}

/**
 * The plan gate's ask, fired at most once per park. A run parked while the user
 * was watching sends nothing — the approval card is right there — so the ask
 * has to be re-offered the moment they stop watching, or the run sits blocked
 * behind a panel nobody is looking at with only a "?" on the tab strip to say
 * so. `notifiedPlanFor` is what keeps "re-offered" from meaning "buzzed on
 * every window switch"; the gate being answered or the run ending releases it.
 */
let notifiedPlanFor: string | null = null;

async function notifyPlanParked(
  conversationId: string,
  steps: string[],
  reapproval: boolean,
): Promise<void> {
  if (notifiedPlanFor === conversationId) return;
  const title = reapproval ? i18n.t("plan.reapprovalTitle") : i18n.t("plan.approvalTitle");
  if (await notifyIfAway("tabrunner-plan", `${title} ${steps.join(" · ")}`, conversationId)) {
    notifiedPlanFor = conversationId;
  }
}

/**
 * Re-offer the parked ask after the fact — called on every window-focus change
 * and when a panel closes, the two ways a watched park becomes an unwatched
 * one. No-op unless a panel run is actually sitting at the gate.
 */
function notifyParkedRun(): void {
  const run = getActiveRun();
  if (run?.owner !== "panel" || !run.planApproval) return;
  const { steps, reapproval } = run.planApproval;
  void notifyPlanParked(run.conversationId, steps, reapproval);
}

// Notification click opens the panel at the right conversation so the user can
// answer — for a finished run, (best-effort) with its tab in front as well.
chrome.notifications.onClicked.addListener((id) => {
  if (id !== "tabrunner-question" && id !== "tabrunner-plan" && !id.startsWith("tabrunner-run-"))
    return;
  chrome.notifications.clear(id);
  const target = notificationTargets.get(id) ?? null;
  notificationTargets.delete(id);
  void (async () => {
    if (target?.conversationId) await setActiveConversation(target.conversationId);
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win.id) await chrome.sidePanel.open({ windowId: win.id });
    if (target?.tabId !== undefined) {
      try {
        await chrome.tabs.update(target.tabId, { active: true });
      } catch {
        // The run's tab is gone — the panel alone still carries the answer.
      }
    }
  })();
});
