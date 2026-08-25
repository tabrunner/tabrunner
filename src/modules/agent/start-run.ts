import { i18n } from "@/i18n";
import { buildConversationHistory, runAgentLoop } from ".";
import { loadMcpForRun } from "@/modules/mcp";
import type { McpRunSnapshot } from "@/modules/mcp";
import { extractAndRemember } from "@/modules/memory";
import { createRecorder } from "@/modules/walkthrough/recorder";
import { maybeAutoTitle } from "@/modules/conversation/title";
import { isPanelOpen } from "@/modules/conversation/panel-ports";
import {
  clearAgentWait,
  createDriver,
  detachAll,
  hideAgentIndicator,
  isRestrictedUrl,
  settleAgentIndicator,
  setAgentDocumenting,
  showAgentIndicator,
  waitAgentIndicator,
  waitForLoad,
} from "@/modules/browser";
import { settleStatusWidgets, type SettleOutcome } from "@/modules/browser/status-widget";
import {
  createProvider,
  engineOf,
  ensureProviderCredential,
  getProviderFor,
  resolveProviderModel,
  sameEngine,
  tokenCost,
} from "@/modules/providers";
import type { ResolvedProviderConfig } from "@/modules/providers/types";
import {
  contextWindowFor,
  learnContextLimit,
  readLearnedLimits,
} from "@/modules/providers/context-window";
import {
  getConversationMeta,
  getMessages,
  getThreadTabsFor,
  recordApprovedPlan,
  recordDrivenTabFor,
  recordEngine,
} from "@/modules/conversation";
import {
  flushConversationWrites,
  type LastTab,
  type ThreadTabs,
} from "@/modules/conversation/conversations";
import type { Message } from "@/modules/conversation/types";
import { defaultStartUrl, walkthroughsEnabled } from "@/lib/prefs";
import { createLogger, truncate } from "@/lib/logger";
import type { Event, PlanApprovalPayload } from "@/shared/protocol";
import { acquireRun, releaseRun } from "./active-runs";
import type { ActiveRun, RunOwner } from "./active-runs";
import type { PlanApprovalOutcome } from "./loop";
import {
  currentBoard,
  markPendingQuestion,
  clearPendingQuestion,
  markRunningAwaiting,
  markRunningRecording,
  markRunningTab,
} from "./run-queue";
import type { RunGroup } from "./tools";

const log = createLogger("bg");

/** Holds the worker up through the post-run memory extraction — see start-run.ts. */
export const MEMORY_KEEPALIVE_ALARM = "tabrunner-memory-keepalive";

export interface StartRunOptions {
  /** The conversation this run's transcript lives in — the panel's active one,
   *  or the bridge's dedicated MCP thread. */
  conversationId: string;
  owner: RunOwner;
  /** The schedule this run fired from — what `schedule_task` is allowed to
   *  re-time, and the only record it may touch. Set for `owner: "schedule"`. */
  scheduleId?: string;
  task: string;
  images?: string[];
  /** Where a background run's tab starts — wins over the default start URL. */
  url?: string;
  /** Work the tab the user is looking at instead of opening one. Implied for a
   *  panel run (see resolveRunTab) and set by an MCP client asking for the
   *  foreground — nobody else has a current tab worth adopting. */
  adoptCurrentTab?: boolean;
  /** Streams run events to the client — the panel port or the bridge's WS. */
  emit: (event: Event) => void;
  /** The run ended on an ask_user question; the client may want to react
   *  (the panel fires an OS notification, the bridge records a pending answer). */
  onAskUser?: (question: string, choices?: string[]) => void;
  /** The run parked on a plan approval — the away notification's cue, same as ask_user. */
  onPlanApprovalRequest?: (ask: PlanApprovalPayload) => void;
}

export type StartRunResult = { ok: true } | { ok: false; active: ActiveRun };

/**
 * The full run-start flow, shared by the panel port and the MCP bridge: claim
 * the single run slot, resolve provider + target tab, drive the loop, distill
 * memory, persist the driven tab. A conflict is returned (never swallowed) so
 * each caller can word it for its own audience.
 */
export async function startAgentRun(opts: StartRunOptions): Promise<StartRunResult> {
  const { conversationId, owner, task, images, emit, onAskUser, onPlanApprovalRequest } = opts;
  const claim = acquireRun(conversationId, owner);
  if (!claim.ok) return { ok: false, active: claim.active };
  const { run } = claim;

  // The run's decision for the ambient pill, made in the inner finally (which
  // can see how the run ended) and read by the release finally (which can see
  // the board settle) — the receipt paints only after the release has pulled
  // the working pill, and only if no queued run took the slot.
  let ambientSettle: { outcome: SettleOutcome; tabId: number } | null = null;
  /** Remote MCP sessions opened mid-setup; closed in the outer finally so
   *  every ending — including the early returns below — tears them down. */
  let mcpPromise: Promise<McpRunSnapshot> | undefined;

  try {
    // What this conversation runs on: its own pin, else the stored pick. The
    // thread owns the engine so a picker change mid-afternoon can't re-point
    // the 9am schedule, and a reopened chat still runs what it always ran.
    const [meta, transcript] = await Promise.all([
      getConversationMeta(conversationId),
      getMessages(conversationId),
    ]);
    const providerConfig = await getProviderFor(meta?.engine);
    if (!providerConfig) {
      emit({ type: "error", message: i18n.t("errors.noActiveProvider") });
      return { ok: true };
    }
    // Pin what actually answered. First run of a fresh thread lands here, and
    // so does a thread whose pinned provider has since been deleted — leaving
    // the stale pin would keep the chip naming an engine that can't run.
    const pick = engineOf(providerConfig);
    if (!sameEngine(meta?.engine, pick)) void recordEngine(conversationId, pick);

    // Resolve "auto" model to a concrete id at run start — mid-task changes to
    // the stored config never affect a run in flight. An OAuth provider gets a
    // fresh access token first, so a long-idle session doesn't 401 mid-task.
    // Checked before the tab is created so a provider failure never orphans one.
    let provider;
    let resolvedProvider: ResolvedProviderConfig | undefined;
    try {
      resolvedProvider = await resolveProviderModel(await ensureProviderCredential(providerConfig));
      provider = createProvider(resolvedProvider);
      // Name the engine before anything else can end the run: the writer stamps
      // it on the run's summary, so the settled band (and a reopened panel) can
      // say what answered — a tab or provider failure from here on still carries it.
      emit({
        type: "engine",
        model: resolvedProvider.model,
        ...(resolvedProvider.reasoningEffort ? { effort: resolvedProvider.reasoningEffort } : {}),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("provider setup failed:", message);
      // Raw exception text — we wrote no copy for it, so the bubble offers a report.
      emit({ type: "error", message, unexpected: true });
      return { ok: true };
    }

    // Remote MCP servers open alongside tab resolution — a slow server costs
    // latency only where it overlaps, and its failure never blocks the run.
    mcpPromise = loadMcpForRun(run.controller.signal);

    // Where the run drives: the user's current tab by default (adopted or
    // this-page), a tab of the run's own only when there's no page to work —
    // dispatch-and-forget never hijacks what the user is reading, but it also
    // never loses the state the task is about. An answer continues where the
    // question arose: a transcript parked on an unanswered ask_user goes back to
    // the very tab the conversation last drove, page state and all.
    const thread = await getThreadTabsFor(conversationId);
    const continuation = hasPendingQuestion(transcript) ? thread.tabs[0] : undefined;
    const target = await resolveRunTab(opts, continuation, thread);

    if ("error" in target) {
      emit({ type: "error", message: target.error });
      return { ok: true };
    }
    const { tab, opened, adopted } = target;
    if (!tab.id) {
      emit({ type: "error", message: i18n.t("errors.noActiveTab") });
      return { ok: true };
    }
    markRunningTab(conversationId, tab.id);

    // The conversation may have worked on other pages than this run's start
    // (one run per message, and users move between messages). Name those tabs
    // so references like "that email" or "the doc" can find their way back
    // (rule 6 does the rest).
    const previousTabs = thread.tabs.filter((t) => t.url !== tab.url);

    log.info("run queued", {
      provider: providerConfig.name,
      model: providerConfig.model ?? "auto",
      tabId: tab.id,
      task: truncate(task, 120),
    });

    let endedOnQuestion = false;
    // The run's closing word — a documented run reuses it as the walkthrough's
    // "what this accomplishes" outro.
    let doneSummary: string | undefined;
    // How the run's tab group is retitled when it lets go — ✓, ? or ✗.
    let runFailed = false;
    // A plain "no" to a plan: nothing ran, so the tab this run opened for the
    // job is litter to take back rather than a result to keep.
    let planRejected = false;
    // A moving target: the run starts on the submit-time tab but the agent may
    // re-target itself with switch_tab — badge, panel chip and fail-fast all follow.
    let drivenTabId = tab.id;
    let drivenTitle = tabLabel(tab);
    // The strip is born lazy: nothing is grouped at send time (the user may just
    // be passing through the tab they sent from) — the loop touches it into
    // being when the run lands its first action, and group_tab can mint it too.
    const runGroup = createRunGroup({
      task,
      keepName: target.resumed === true,
      ...(target.threadGroupId !== undefined ? { seedGroupId: target.threadGroupId } : {}),
      drivenTabId: () => drivenTabId,
    });
    const driver = createDriver(tab.id, {
      // A run follows its own switches on screen only while somebody is there
      // to watch — asked live, so the moment the panel closes the run stops
      // moving the user's screen. Nobody watching, nothing moves: that is what
      // walking away buys, whether it was chosen at send time or mid-run.
      activateOnSwitch: isPanelOpen,
      onSwitch: (info) => {
        void hideAgentIndicator(drivenTabId);
        drivenTabId = info.id;
        drivenTitle = info.title;
        markRunningTab(conversationId, info.id);
        emit({
          type: "driving",
          tabId: info.id,
          windowId: info.windowId,
          title: info.title,
          url: info.url,
          favIconUrl: info.favIconUrl,
        });
        void showAgentIndicator(info.id);
      },
    });
    emit({
      type: "driving",
      tabId: drivenTabId,
      windowId: tab.windowId,
      title: drivenTitle,
      ...(tab.url ? { url: tab.url } : {}),
      favIconUrl: tab.favIconUrl || undefined,
    });

    // The driven tab going away is fatal, not transient: every later tool call
    // would fail the same way. End the run with a clear error instead of letting
    // the model burn turns retrying a dead tab id.
    const onTabGone = (removedId: number) => {
      if (removedId !== drivenTabId) return;
      log.info("driven tab closed mid-run", { tabId: drivenTabId });
      runFailed = true;
      // The user closed the tab — that IS the answer, no notification on top.
      emit({
        type: "error",
        message: i18n.t("errors.tabClosed", { title: drivenTitle }),
        silent: true,
      });
      run.controller.abort();
    };
    chrome.tabs.onRemoved.addListener(onTabGone);
    // Tell the page itself it is being driven — the side panel may be scrolled
    // away or on another window.
    await clearAgentWait();
    chrome.notifications.clear("tabrunner-question");
    chrome.notifications.clear("tabrunner-plan");
    // A fresh run is itself the answer to whatever question was parked — or the
    // user moved on, and the question is stale either way. Both retire it.
    clearPendingQuestion(conversationId);
    void showAgentIndicator(drivenTabId);

    // What this model can hold — a ceiling an earlier run learned from a
    // refusal, the endpoint's own listing, or the 200k default. It sets both
    // how much conversation gets replayed and when the run folds its own turns.
    const contextWindow = contextWindowFor(resolvedProvider, await readLearnedLimits());

    // The stored conversation as wire turns — "continue" lands on a model that
    // has read the same exchange, not on a stranger.
    const history = buildConversationHistory(transcript, contextWindow);

    // Present whenever walkthroughs are on; the `document` tool is what arms
    // it. An unarmed recorder captures nothing and costs a pair of no-op calls
    // per action — which is what lets the model turn documenting on mid-run,
    // the moment the user asks for it in prose.
    const recorder = (await walkthroughsEnabled.get())
      ? createRecorder(conversationId, task, () => {
          emit({ type: "recording", on: true });
          // Ambient, not just panel state: the driven tab's badge and the
          // toolbar title have to say REC after the panel closes.
          markRunningRecording(conversationId, true);
          void setAgentDocumenting(true);
        })
      : undefined;

    try {
      const mcp = await mcpPromise;
      // One neutral row per server that failed to open — never a red ✗ (a dead
      // remote is not a failed action) and silent on success: availability is
      // legible from the tools simply appearing in the model's set.
      for (const failure of mcp.failures) emit({ type: "step", tool: "mcp", summary: failure });
      const wire = await runAgentLoop({
        provider,
        driver,
        task,
        conversationId,
        runGroup,
        owner,
        ...(mcp.tools.length > 0 ? { mcp } : {}),
        ...(recorder ? { recorder } : {}),
        ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
        images,
        supportsImages: resolvedProvider?.supportsImages,
        history: history.length > 0 ? history : undefined,
        // The conversation's standing plan approval — what an earlier run's
        // gate already said yes to, so a "continue" doesn't re-ask it.
        ...(meta?.approvedPlan?.length ? { standingPlan: meta.approvedPlan } : {}),
        contextWindow,
        previousTabs: previousTabs.length > 0 ? previousTabs : undefined,
        mode: adopted ? "adopted" : "own",
        ...(tab.url ? { startUrl: tab.url } : {}),
        drainInjected: () => run.injectedQueue.splice(0, run.injectedQueue.length),
        signal: run.controller.signal,
        callbacks: {
          onInjected: (id, text) => emit({ type: "injected", id, text }),
          // A refusal is the only hard number any endpoint gives us about its
          // window — persisted so the NEXT run on this model starts knowing it.
          onContextLimit: (observed) => {
            void learnContextLimit(resolvedProvider, observed);
          },
          onToken: (text) => emit({ type: "token", text }),
          onReasoning: (text) => emit({ type: "reasoning", text }),
          onStepStart: (tool, args) => emit({ type: "step_start", tool, args }),
          onStep: (step) => emit({ type: "step", ...step }),
          onPlan: (plan) => emit({ type: "plan", ...plan }),
          // The gate's yes is the conversation's, not the run's: persist each
          // transition so the next run's first plan call doesn't re-ask it.
          onApprovedPlanChange: (steps) => void recordApprovedPlan(conversationId, steps),
          onPlanApproval: (ask) => {
            // The gate is the panel's, because the panel is the only owner with
            // a human at the other end. A bridge client is itself an AI carrying
            // the consequential-action policy, and a scheduled run's consent was
            // given when the user approved creating the schedule — parking
            // either one would hang a run nobody can answer. The plan still
            // crosses the event stream and lands in the transcript for review.
            if (owner !== "panel") return Promise.resolve({ approved: true });
            emit({ type: "plan_approval", ...ask });
            // Parked runs stall silently otherwise — the user has usually tabbed
            // away by the time a mid-run replan asks again.
            onPlanApprovalRequest?.(ask);
            // Parked means blocked-on-you, not working: the driven tab settles
            // into the same still "?" an ask_user wait shows, and the board's
            // pulse stops. An approve re-raises both; a reject (or stop) ends
            // the run, whose unwind clears them.
            markRunningAwaiting(conversationId, true);
            void waitAgentIndicator(drivenTabId);
            return new Promise<PlanApprovalOutcome>((resolve) => {
              run.planApproval = {
                ask,
                resolve: (approved, feedback) => {
                  const revision = approved ? undefined : feedback?.trim() || undefined;
                  // Approve or revise: the run works again, so the working marks
                  // return. A plain reject ends it — its unwind clears them.
                  if (approved || revision) {
                    markRunningAwaiting(conversationId, false);
                    void showAgentIndicator(drivenTabId);
                  } else {
                    planRejected = true;
                  }
                  resolve(revision ? { approved: false, feedback: revision } : { approved });
                },
              };
              // A stop (or the panel closing) while parked answers "no", so the
              // loop unwinds instead of hanging on a promise nobody resolves.
              run.controller.signal.addEventListener(
                "abort",
                () => {
                  run.planApproval?.resolve(false);
                  run.planApproval = undefined;
                },
                { once: true },
              );
            });
          },
          onUsage: (tick) => {
            // Accumulated here rather than by each consumer: this is the one
            // adapter turning loop callbacks into events, so it is the one
            // place that can answer "what has this run spent" to a panel that
            // arrived late. The panel and the transcript writer both just set.
            run.usage.input += tick.input;
            run.usage.output += tick.output;
            if (tick.input > 0) run.usage.contextTokens = tick.input;
            // A gateway that priced the call wins over the table's estimate;
            // an unknown model prices nothing and the run stays costless.
            const spent = tick.cost ?? tokenCost(resolvedProvider.model, tick);
            if (spent !== undefined) run.usage.cost = (run.usage.cost ?? 0) + spent;
            emit({ type: "usage", ...run.usage });
          },
          onError: (message, kind) => {
            runFailed = true;
            // An unclassified provider failure is the signal that a provider
            // changed something we don't know yet — the same distinction the
            // loop draws when it picks log.error over log.warn. Classified
            // states (rate limit, quota, auth) are not bugs and carry their
            // own fix, so they stay off the report path.
            emit({ type: "error", message, kind, ...(kind ? {} : { unexpected: true }) });
          },
          onDone: (summary) => {
            doneSummary = summary;
            emit({
              type: "done",
              summary,
              ...(endedOnQuestion ? { question: true } : {}),
              // A user halt unwinds as a done — the aborted controller is the
              // only thing that tells it from a finish the model chose.
              ...(run.controller.signal.aborted ? { stopped: true } : {}),
            });
          },
          onAskUser: (question, choices) => {
            endedOnQuestion = true;
            // The slot is about to free, but the answer is still owed — record
            // the question as an ambient board fact, or the widget, badge and a
            // reopened panel would all go silent as if the run simply ended.
            markPendingQuestion(conversationId, question, choices);
            onAskUser?.(question, choices);
          },
        },
      });
      // Two background niceties after a finished run: one cheap call distills
      // the durable facts the agent never got around to remembering, another
      // names a conversation the first line titled badly. Fire-and-forget —
      // best-effort, neither failure touches the run. But not unprotected: the
      // board's keepalive alarm clears the moment this run lets go of its slot,
      // the panel has long closed itself, and an MV3 worker with nothing pending
      // is killed mid-fetch — the call (and its write) dies with it. A dedicated
      // alarm holds the worker up until both settle; background.ts clears a
      // stale one at boot.
      if (!run.controller.signal.aborted && resolvedProvider) {
        void chrome.alarms.create(MEMORY_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
        // Where the run ended is where its lessons belong — the extraction gets
        // the driven tab's final URL as its site hint. Tab-died tolerance
        // mirrors persistDrivenTabFor; the lookup rides the chain so the
        // teardown below never waits on it.
        const backgroundProvider = resolvedProvider;
        const extraction = chrome.tabs
          .get(drivenTabId)
          .then((t) => t.url)
          .catch(() => undefined)
          .then((finalUrl) =>
            extractAndRemember(backgroundProvider, wire, run.controller.signal, finalUrl),
          );
        // The task's one-line title may be a fragment ("hey" off a two-line
        // message) — one cheap call names it for real. Passed unconditionally:
        // whether this task is the one that named the thread is a question
        // about the STORED title, not about the transcript (which already holds
        // this run's own user message by the time the run reads it), and
        // maybeAutoTitle answers it against storage.
        const titling = maybeAutoTitle(
          conversationId,
          task,
          backgroundProvider,
          run.controller.signal,
        );
        // One keepalive for both, cleared only once both have settled — two
        // `finally`s on one alarm name meant the quicker call pulled the
        // worker's hold out from under the slower one.
        void Promise.allSettled([extraction, titling]).finally(() => {
          void chrome.alarms.clear(MEMORY_KEEPALIVE_ALARM);
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("run crashed:", message);
      runFailed = true;
      emit({ type: "error", message, unexpected: true });
    } finally {
      chrome.tabs.onRemoved.removeListener(onTabGone);
      // The walkthrough closes before the session does: its last frame is the
      // result the reader is working toward, and `detachAll()` below takes the
      // capture path with it. Every ending funnels through this one finally —
      // done, error, stop, a closed tab, a crashed loop — so one seam covers
      // them all, and a recording is never lost to the way a run happened to
      // end. Best-effort: a failed finalize must not strand the teardown.
      if (recorder?.armed) {
        try {
          const outcome = runFailed ? "error" : run.controller.signal.aborted ? "stopped" : "done";
          const recording = await recorder.finalize(outcome, doneSummary);
          if (recording && recording.frames > 0) {
            emit({
              type: "artifact",
              recordingId: recording.id,
              title: recording.title,
              frames: recording.frames,
              status: recording.status,
              sites: recording.sites,
            });
          }
        } catch (e) {
          log.warn("walkthrough finalize failed:", e instanceof Error ? e.message : String(e));
        }
        emit({ type: "recording", on: false });
        markRunningRecording(conversationId, false);
        void setAgentDocumenting(false);
      }
      // The debugger leaves with the run: its session is what keeps Chrome's
      // "debugging this browser" infobar up, and held past the run's end it
      // would pin the banner on a page nothing is driving — it even outlives
      // the worker. Awaited so the slot never frees with a detach in flight.
      await detachAll();
      // The mark's ending matches the run's: a question keeps it up as the
      // still "?" (the answer is still owed), a stop or a rejected plan just
      // takes it down — the user did that, and the panel already says so — and
      // a finished or failed run settles into the receipt instead of quietly
      // vanishing, which reads exactly like a crash.
      if (endedOnQuestion) void waitAgentIndicator(drivenTabId);
      else if (run.controller.signal.aborted || planRejected) void hideAgentIndicator(drivenTabId);
      else {
        const outcome: SettleOutcome = runFailed ? "failed" : "done";
        void settleAgentIndicator(drivenTabId, outcome);
        ambientSettle = { outcome, tabId: drivenTabId };
      }
      // The thread's strip: the one this run minted, or the seed it was told to
      // join. A run that only read a page mints nothing, yet its tab is sitting
      // in the thread's strip all the same — recording no group there is what
      // makes the next run mint a second one.
      const threadGroupId = runGroup.groupId ?? target.threadGroupId;
      // Runs whatever unwinds the loop — done, error, stop, question. A "no" to
      // the plan is the exception: the tab this run opened for the job is litter
      // to take back rather than a result to keep, and a page the agent only
      // glanced at is not where the conversation now lives.
      if (planRejected && opened) {
        await discardRunTab(tab.id);
      } else if (planRejected && adopted) {
        // "No, don't touch this" names no outcome. Nothing is unfiled: the gate
        // means a first-plan rejection happens before any grouping, and after a
        // mid-run replan the strip holds real work. Just put it away.
        await collapseRunGroup(runGroup.groupId);
        await persistDrivenTabFor(conversationId, drivenTabId, threadGroupId);
      } else {
        await persistDrivenTabFor(conversationId, drivenTabId, threadGroupId);
        const outcome = runFailed ? "failed" : endedOnQuestion ? "question" : "done";
        await settleRunTab(runGroup.groupId, task, outcome);
        // An unattended run's own tab is scratch space, not a result. Nobody
        // asked for it and nobody is looking at it, so leaving one behind per
        // fire means an hourly schedule buries the browser inside a day — the
        // answer lives in the transcript and the notification, which is where
        // the user actually goes for it. Only ever the tab this run created
        // (`opened`), never a tab it switched into, which is the user's.
        //
        // Kept on any other ending: a failure is worth looking at, a parked
        // question needs the page state its answer will come back to, and a
        // user who hit Stop is taking the tab over.
        if (
          owner === "schedule" &&
          opened &&
          outcome === "done" &&
          !run.controller.signal.aborted
        ) {
          await discardRunTab(tab.id);
        }
      }
    }
  } finally {
    // Remote sessions die with the run — here, in the OUTER finally, because
    // the early provider/target returns above never reach the inner one. The
    // DELETE is best-effort and independent of the debugger, so ordering with
    // detachAll is free; a hung close must not strand the unwind either way.
    try {
      await mcpPromise?.then((m) => m.handle.close());
    } catch {
      // The snapshot itself failed — nothing to close.
    }
    // The transcript must be durable before the board moves: the panel reloads
    // it the moment the slot clears, and a read that beats a pending append
    // paints a transcript missing the run's closing messages over the live view
    // that just received them (see flushConversationWrites).
    try {
      await flushConversationWrites();
    } catch {
      // Best effort — a stuck flush must never pin the run slot.
    }
    releaseRun(run);
    // The ambient pill's receipt — only when the board actually emptied (a
    // queued run owns the pill now). Fired after the release on purpose: the
    // board change the release broadcasts removes the working pill, and the
    // receipt paints in its place.
    if (ambientSettle) {
      const board = currentBoard();
      if (!board.running && board.queue.length === 0 && !board.pendingQuestion) {
        void settleStatusWidgets(ambientSettle.outcome, ambientSettle.tabId);
      }
    }
  }
  return { ok: true };
}

/** Best human label for a tab — its title, then hostname, then nothing. */
function tabLabel(tab: chrome.tabs.Tab): string {
  if (tab.title) return tab.title;
  try {
    return tab.url ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

/**
 * The ask-gate's rule, background-side (the panel's copy lives in
 * conversation/ui/ask-gate.ts, which the runtime boundary keeps out of reach):
 * the newest ask_user with no user message after it is still awaiting an
 * answer — so this submission is a continuation, not a fresh task.
 */
function hasPendingQuestion(transcript: Message[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m?.role === "user") return false;
    if (m?.role === "step" && m.tool === "ask_user") return true;
  }
  return false;
}

interface RunTab {
  tab: chrome.tabs.Tab;
  /** The thread's live strip, resolved at run start — the seed the run's own
   *  labeling joins. Never the run's group: the run has none until its first action. */
  threadGroupId?: number;
  /** The run continues a parked question — it joins its strip without renaming it. */
  resumed?: boolean;
  /** This run opened the tab, so a rejected plan can take it back. */
  opened?: boolean;
  /** This run took over the user's current tab — drive it, never close it. */
  adopted?: boolean;
}

/** Last-resort start page when neither the task nor the preference names one. */
const FALLBACK_START_URL = "https://www.google.com";

/**
 * Pages that mean "no page" rather than "a page we were blocked from": the user
 * opened a tab and typed a task into it. Falling back to the start page is the
 * whole answer there — telling the model it was blocked would invent a page the
 * user never had.
 */
function isBlankPage(url: string | undefined): boolean {
  return !url || /^(about:blank|about:newtab|chrome:\/\/(newtab|new-tab-page))\/?$/i.test(url);
}

/**
 * Where the run drives — ONE answer, whether the user is watching or has walked
 * away. Foreground and background are the same run: the toggle decides whether
 * the panel stays open, never which tab the work happens on. Two resolutions
 * would make the toggle a hidden second setting, which is exactly what "this
 * page" used to read like.
 *
 * A panel run adopts the tab the user is on: the state the task is about — the
 * half-filled form, the search results, the scrolled thread — lives there and
 * nowhere else, and re-visiting its url in a fresh tab would both lose it and
 * open a second live session the site may read as a bot. So the run takes the
 * tab as-is and the plan gate carries the "don't touch this" decision to the
 * user; the tab is never the run's to close. Grouping waits for the first
 * action — a message sent in passing must not file the tab the user happens to
 * be on.
 *
 * Only when there is no page to adopt — a blank/new-tab page, a page Chrome
 * forbids, an MCP client (nowhere near a browser, unless it asked for the
 * foreground), or an explicit target URL — does the run open a tab of its own,
 * on the start-page preference. It opens inactive and is never brought forward.
 *
 * No run moves the user's screen at send time: a continuation reuses its tab in
 * place, an adopted run is already on it, and the follow (the driver bringing a
 * switched-to tab forward) needs an open panel and the user still sitting on the
 * tab being left. The sidebar is the watch surface; the chip and the
 * notification click are how the user looks at the tab — the run never decides
 * that for them. An MCP client's run is never revealed either: nobody is at the
 * browser, and reaching over to raise Chrome over the editor they ARE looking
 * at is the hijack this all avoids.
 */
async function resolveRunTab(
  opts: StartRunOptions,
  continuation: LastTab | undefined,
  thread: ThreadTabs,
): Promise<RunTab | { error: string }> {
  const reused = await reuseContinuationTab(continuation, thread);
  if (reused) return reused;

  // A panel run works the tab the user is looking at — the state the task is
  // about (the half-filled form, the search results, the scrolled thread) lives
  // there and only there. Re-visiting its url in a fresh tab would answer about
  // a cold copy, and open a second live session the site may read as a bot.
  // Adoption takes the tab as-is; the run reads it and proposes a plan before
  // any action tool is unlocked, so "don't touch this draft" is a plan
  // rejection, not a fork. A URL names its own page, so it never adopts.
  const adopt = !opts.url && (opts.owner === "panel" || opts.adoptCurrentTab === true);
  if (adopt) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url && !isBlankPage(tab.url) && !isRestrictedUrl(tab.url)) {
      try {
        if (tab.status === "loading") await waitForLoad(tab.id, 10_000);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      const threadGroupId = await liveThreadGroup(thread, tab);
      return {
        tab,
        adopted: true,
        ...(threadGroupId !== undefined ? { threadGroupId } : {}),
      };
    }
  }

  const start = await resolveStartUrl(opts, continuation?.url);
  if (isRestrictedUrl(start.url)) return { error: i18n.t("errors.restrictedPage") };
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ active: false, url: start.url });
  } catch (e) {
    return {
      error: i18n.t("errors.tabCreateFailed", {
        message: e instanceof Error ? e.message : String(e),
      }),
    };
  }
  if (!tab.id) return { error: i18n.t("errors.noActiveTab") };
  try {
    await waitForLoad(tab.id, 15_000);
  } catch (e) {
    // A tab the run never drove is litter — close it on the way out.
    void chrome.tabs.remove(tab.id).catch(() => {});
    return { error: e instanceof Error ? e.message : String(e) };
  }
  // Re-read after the wait — the created record predates the navigation.
  const loaded = await chrome.tabs.get(tab.id);
  // A brand-new tab has no strip of its own to keep — the records and the
  // window's contents point at the thread's. Grouping waits for the first action.
  const threadGroupId = await liveThreadGroup(thread, loaded);
  // Never revealed — only background runs open a tab of their own (above).
  return {
    tab: loaded,
    opened: true,
    ...(threadGroupId !== undefined ? { threadGroupId } : {}),
  };
}

/**
 * The very tab the question was asked on, when it is still alive and still
 * there. Re-opening its url would also "continue where the question arose", but
 * a fresh load throws away the state the question was ABOUT — the half-filled
 * booking form, the search results, the scrolled thread. The parked strip is
 * resolved like any run's: the tab still sitting in it seeds the join, across a
 * restart's id churn too, while a tab the user refiled while the question
 * waited fails the ownership check — theirs, and the continuation neither
 * renames it nor rips the tab out.
 */
async function reuseContinuationTab(
  last: LastTab | undefined,
  thread: ThreadTabs,
): Promise<RunTab | undefined> {
  if (last?.tabId === undefined) return undefined;
  try {
    const tab = await chrome.tabs.get(last.tabId);
    const threadGroupId = await liveThreadGroup(thread, tab);
    // The run continues where the question arose — the very tab it was driving,
    // which under adoption IS the user's tab. The model must hear that, or it
    // reads the "your own tab is untouched" line while sitting on theirs.
    return {
      tab,
      adopted: true,
      resumed: true,
      ...(threadGroupId !== undefined ? { threadGroupId } : {}),
    };
  } catch {
    // The tab died while the question waited — open a fresh one on its url.
    return undefined;
  }
}

/** The page a run's own tab opens on, and the page Chrome kept it from opening. */
async function resolveStartUrl(
  opts: StartRunOptions,
  continuationUrl: string | undefined,
): Promise<{ url: string }> {
  // Both name the page outright: the bridge's `url` argument, and a
  // continuation whose tab is gone but whose page is known.
  const named = opts.url || continuationUrl;
  if (named) return { url: named };

  // Only a panel run has a "page the user is on" — an MCP client is somewhere
  // else entirely, and its session starts on the neutral default. The panel
  // adoption path has already taken the user's tab when it could; reaching here
  // means that tab was blank or blocked, so the run opens its own on the
  // start-page preference (or the fallback), never a copy of a page it can't see.
  const url = (await defaultStartUrl.get()) || FALLBACK_START_URL;
  return { url };
}

/** Takes back a tab this run opened and never earned — best-effort, it may be gone. */
async function discardRunTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Already closed — the group went with it.
  }
}

/** Put the strip away without naming an outcome — a rejected plan's settle. */
async function collapseRunGroup(groupId: number | undefined): Promise<void> {
  if (groupId === undefined) return;
  try {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  } catch {
    // The group died during the run.
  }
}

/** Tab-group titles cap at ~25 chars before they ellipsis into noise. */
const GROUP_TITLE_MAX = 25;

function groupTitle(task: string, mark = ""): string {
  const excerpt = task.replace(/\s+/g, " ").trim();
  const short =
    excerpt.length > GROUP_TITLE_MAX ? `${excerpt.slice(0, GROUP_TITLE_MAX)}…` : excerpt;
  return `${mark}${short}`;
}

/** The outcome mark a run leaves on its group's title — resume strips it, settle re-marks it. */
const SETTLE_MARK = /^[✓✗?] /;

/**
 * A group is this thread's only while it still carries our fingerprints: every
 * strip we label is green, and a settled one wears its outcome mark. Anything
 * else is a group the user built — even around a page we happened to drive —
 * and is never ours to rename or rip.
 */
function isThreadStrip(group: chrome.tabGroups.TabGroup): boolean {
  return SETTLE_MARK.test(group.title ?? "") || group.color === "green";
}

/**
 * The group the thread's tabs live under, when it is still the thread's. One
 * strip per conversation PER WINDOW — Chrome groups can't span windows — found
 * by content, not by remembered ids: tab and group ids die with a browser
 * restart, the urls the conversation drove survive them.
 *
 * Strongest first: the tab in hand, already sitting in a strip of ours on a url
 * this conversation drove — never rip the tab the user is looking at out of its
 * strip. Then the records, by liveness: strips outlive their tabs (the driven
 * tab gets closed once the task is done; the group_tab'd ones stay), so a
 * recorded group still alive in this window IS the thread's — ownership checked,
 * since a restarted browser can hand an old id to somebody else's group. Last,
 * the window itself: a strip session-restore recreated under fresh ids is found
 * by what it holds — any page the thread worked, which is why the strip's whole
 * membership is recorded and not just the tab the run drove. That is the case
 * the driven-tab list alone cannot answer: the user closes the finished tab and
 * the strip stands on the ones `group_tab` filed.
 */
export async function liveThreadGroup(
  thread: ThreadTabs,
  forTab: chrome.tabs.Tab,
): Promise<number | undefined> {
  const { tabs } = thread;
  const seen = new Set<number>();
  const owns = async (groupId: number): Promise<boolean> => {
    try {
      return isThreadStrip(await chrome.tabGroups.get(groupId));
    } catch {
      return false; // dead group — no strip there
    }
  };

  if (
    forTab.url &&
    forTab.groupId >= 0 &&
    tabs.some((t) => t.url === forTab.url) &&
    (await owns(forTab.groupId))
  ) {
    return forTab.groupId;
  }
  seen.add(forTab.groupId);

  for (const t of tabs) {
    if (t.groupId === undefined || seen.has(t.groupId)) continue;
    seen.add(t.groupId);
    try {
      const group = await chrome.tabGroups.get(t.groupId);
      if (group.windowId === forTab.windowId && isThreadStrip(group)) return t.groupId;
    } catch {
      // Dead group — try the next record.
    }
  }

  // The window scan: a strip the records can no longer name (session restore
  // recreated it under fresh ids) is still sitting there, holding pages the
  // thread worked. Driven urls first — the strongest evidence — then the rest
  // of what the strip held when it settled.
  let windowTabs: chrome.tabs.Tab[];
  try {
    windowTabs = await chrome.tabs.query({ windowId: forTab.windowId });
  } catch {
    return undefined;
  }
  const groupedByUrl = new Map<string, number>();
  for (const t of windowTabs) {
    if (t.url && t.groupId >= 0 && !groupedByUrl.has(t.url)) groupedByUrl.set(t.url, t.groupId);
  }
  for (const url of [...tabs.map((t) => t.url), ...thread.stripUrls]) {
    const groupId = groupedByUrl.get(url);
    if (groupId === undefined || seen.has(groupId)) continue;
    seen.add(groupId);
    if (await owns(groupId)) return groupId;
  }
  return undefined;
}

/**
 * Group the run's tab and name the group after the task — the strip then says
 * what that tab is. A follow-up in the same thread files its tab under the
 * group the thread already has (one labeled strip per conversation, not one
 * per run); a stale id — closed group, or the group lives in another window —
 * falls back to a fresh group. keepName is for continuations: the strip keeps
 * the name it parked with (unmarked, re-expanded), because the task at hand is
 * the user's answer fragment, not a name. Best-effort: grouping must never
 * fail a run.
 */
export async function labelRunTab(
  tabId: number,
  task: string,
  threadGroupId?: number,
  keepName = false,
): Promise<number | undefined> {
  try {
    const groupId =
      threadGroupId === undefined
        ? await chrome.tabs.group({ tabIds: tabId })
        : await chrome.tabs
            .group({ tabIds: tabId, groupId: threadGroupId })
            .catch(() => chrome.tabs.group({ tabIds: tabId }));
    let title = groupTitle(task);
    if (keepName) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        const base = group.title?.replace(SETTLE_MARK, "").trim();
        if (base) title = base;
      } catch {
        // The group's name is unreadable — the task title stands.
      }
    }
    // Re-open a settled (collapsed) group: the user just pressed send and is
    // watching this tab — a collapsed group would swallow it.
    await chrome.tabGroups.update(groupId, { title, color: "green", collapsed: false });
    return groupId;
  } catch (e) {
    log.debug("tab grouping skipped:", e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

/**
 * The run's strip, minted on first touch (see RunGroup in tools.ts for the
 * contract). Joins the thread's seed strip when one was resolved at run start;
 * otherwise mints around the first tab the run acts on. Either way the tab must
 * be loose or already home: a tab sitting in any other group is left alone —
 * that's a group the user (or another chat) owns, never ours to rip.
 */
export function createRunGroup(opts: {
  task: string;
  /** A continuation joins its parked strip without renaming it. */
  keepName: boolean;
  /** The thread's live strip, resolved at run start — the run's labeling joins it. */
  seedGroupId?: number;
  drivenTabId: () => number;
}): RunGroup {
  let groupId: number | undefined;

  const label = async (tabId: number): Promise<number | undefined> => {
    if (groupId !== undefined) {
      // The strip exists — file the tab into it. Best-effort: a tab in another
      // window can't join, and a run never fails over its strip.
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId });
      } catch {
        // Cross-window or gone — the tab stays where it is.
      }
      return groupId;
    }
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.groupId >= 0 && t.groupId !== opts.seedGroupId) return undefined;
    } catch {
      return undefined; // the tab died between the tool call and here
    }
    groupId = await labelRunTab(tabId, opts.task, opts.seedGroupId, opts.keepName);
    return groupId;
  };

  return {
    get groupId() {
      return groupId;
    },
    touch: async () => {
      await label(opts.drivenTabId());
    },
    file: (tabId) => label(tabId),
  };
}

/**
 * Retitle the run's tab group with the outcome and collapse it — the strip
 * keeps saying what happened, out of the user's way. Only the mark changes: the
 * name the group already carries survives, because on a continuation the task
 * at hand is the user's answer fragment ("the March one"), and a name the user
 * gave the strip themselves is theirs. Best-effort: the tab may already be gone.
 */
export async function settleRunTab(
  groupId: number | undefined,
  task: string,
  outcome: "done" | "failed" | "question",
): Promise<void> {
  if (groupId === undefined) return;
  const mark = outcome === "failed" ? "✗ " : outcome === "question" ? "? " : "✓ ";
  try {
    const group = await chrome.tabGroups.get(groupId);
    const base = group.title?.replace(SETTLE_MARK, "").trim() || task;
    await chrome.tabGroups.update(groupId, { title: groupTitle(base, mark), collapsed: true });
  } catch {
    // The tab (and its group) died during the run.
  }
}

/**
 * What the thread's strip holds now — the key the next run re-finds it by once
 * ids have died. Read at settle rather than accumulated during the run: the
 * group itself is the record, so a tab the user pulled out drops out, and one
 * query covers every way a tab got in (the driven tab, the tabs the run
 * switched through, the ones `group_tab` filed). Undefined when the run had no
 * strip — the thread's last known membership stands rather than being erased.
 */
async function stripMembership(threadGroupId: number | undefined): Promise<string[] | undefined> {
  if (threadGroupId === undefined) return undefined;
  try {
    const tabs = await chrome.tabs.query({ groupId: threadGroupId });
    return tabs.map((t) => t.url).filter((url): url is string => !!url);
  } catch {
    return undefined; // the group died with the run — keep what we knew
  }
}

/**
 * Remember the tab this run drove so the next run can spot a tab change — and
 * go back to the tab itself when it answers a question — plus what the strip
 * holds, in one write. The final state is read fresh: navigations mid-run leave
 * the start-time title, url and group stale.
 */
async function persistDrivenTabFor(
  conversationId: string,
  tabId: number,
  threadGroupId: number | undefined,
): Promise<void> {
  const stripUrls = await stripMembership(threadGroupId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;
    await recordDrivenTabFor(
      conversationId,
      {
        url: tab.url,
        title: tab.title ?? "",
        tabId,
        // Only the thread's own strip counts: a tab the run switched into
        // mid-flight may sit in a group of the user's own, and that label is
        // theirs — never ours to reuse or retitle.
        ...(threadGroupId !== undefined && tab.groupId === threadGroupId
          ? { groupId: tab.groupId }
          : {}),
      },
      stripUrls,
    );
  } catch {
    // The tab died during the run — nothing left to remember. The strip
    // snapshot rides with it; the previous run's stands until one lands.
  }
}
