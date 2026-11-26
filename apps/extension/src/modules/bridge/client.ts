import { i18n } from "@/i18n";
import { createLogger, truncate } from "@/lib/logger";
import { createWriteQueue } from "@/lib/storage";
import {
  BRIDGE_DISCONNECTED,
  getActiveRun,
  getOwnerRun,
  getRunById,
} from "@/modules/agent/active-runs";
import { compactConversation } from "@/modules/agent/compact";
import {
  clearPendingQuestion,
  getPendingQuestion,
  listQueue,
  submitRun,
} from "@/modules/agent/run-queue";
import type { QueuedRun } from "@/modules/agent/run-queue";
import { startAgentRun } from "@/modules/agent/start-run";
import type { PlanApprovalOutcome } from "@/modules/agent/loop";
import { listOpenTabs } from "@/modules/browser/driver";
import { isAttached, screenshot, tabOwner } from "@/modules/browser";
import {
  appendMessageTo,
  getConversationMeta,
  openAgentConversation,
} from "@/modules/conversation";
import { cancelQueuedTask, recordTaskCancellation } from "@/modules/conversation/conversations";
import { TranscriptWriter } from "@/modules/conversation/transcript";
import {
  createProvider,
  ensureProviderCredential,
  getProviderFor,
  resolveProviderModel,
} from "@/modules/providers";
import type { BridgeActive, Event } from "@/shared/protocol";
import { bridgeThread } from "./config";
import { DirectSession } from "./direct";
import type { BridgeRunEvent, BridgeStatus, CompactRunEvent } from "./protocol";
import { applyQuestion, applyStatusEvent, emptyStatus, newRunStatus } from "./status";

const log = createLogger("bridge");

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One MCP session owns one command lane, conversation, status mirror and browser session. */
export class BridgeClient {
  constructor(
    readonly id: string,
    private readonly send: (event: BridgeRunEvent) => void,
    private readonly onActivity: () => void,
  ) {
    this.thread = bridgeThread(id);
    this.direct = new DirectSession(id, (run) => {
      if (this.status.runId === run.id) {
        this.publish({ type: "done" });
        this.status.state = "done";
        this.status.finishedAt = Date.now();
      }
      this.clearActivity(run.id);
    });
  }

  private readonly serialize = createWriteQueue();
  private readonly direct: DirectSession;
  private readonly thread: ReturnType<typeof bridgeThread>;
  private status: BridgeStatus = emptyStatus();
  private active: BridgeActive | null = null;
  private closed = false;
  private launched: Promise<void> | null = null;
  private queuedAnswer: { id: string; question: string; choices?: string[] } | null = null;
  private confirmation: { id: string; resolve: (outcome: PlanApprovalOutcome) => void } | null =
    null;

  get activity(): BridgeActive | null {
    return this.active;
  }

  command(method: string, params: Record<string, unknown>, runId?: string): Promise<unknown> {
    return this.serialize(async () => {
      if (this.closed) throw staleRun();
      switch (method) {
        case "sync": {
          this.status.conversationId ??= await this.thread.get();
          if (!this.status.runId && this.status.conversationId) {
            const pending = getPendingQuestion(this.status.conversationId);
            if (pending?.runId) {
              this.status.runId = pending.runId;
              this.status.startedAt = pending.startedAt ?? null;
              applyQuestion(this.status, pending.question, pending.choices);
            }
          }
          this.updateQueue(listQueue());
          return this.status;
        }
        case "run":
          if (this.status.state === "question" || this.queuedAnswer)
            throw new BridgeError(
              "question-pending",
              "This task is waiting for the user. Use answer to reply, or stop it to start another task.",
            );
          return this.beginRun(params);
        case "answer":
          return this.answer(params, runId);
        case "browserTabs": {
          const query = str(params.query).toLowerCase();
          const tabs = await listOpenTabs();
          return {
            ok: true,
            data: {
              tabs: query
                ? tabs.filter((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(query))
                : tabs,
            },
          };
        }
        case "steer": {
          const run = this.requireActive(runId);
          if (this.direct.open) throw staleRun();
          const text = str(params.text);
          if (!text) throw new BridgeError("empty-text", "Enter a steer message, then try again.");
          run.injectedQueue.push({ id: crypto.randomUUID(), text });
          return { ok: true };
        }
        case "stop":
          return this.stop(runId);
        case "screenshot":
          return this.capture(runId);
        case "browserStart":
          return this.beginDirect(params);
        case "browserAct": {
          this.requireActive(runId);
          if (!this.direct.open) throw staleRun();
          const result = await this.direct.act(
            str(params.tool),
            args(params.args),
            params.snapshot !== false,
          );
          await this.updateDriving();
          return result;
        }
        case "browserEnd":
          this.requireActive(runId);
          if (!this.direct.open) throw staleRun();
          await this.direct.end();
          return { ok: true };
        case "newConversation":
          return this.newConversation(runId);
        case "compact":
          return this.compact(runId);
        default:
          throw new BridgeError("unknown-method", `Unknown bridge method: ${method}`);
      }
    });
  }

  /** Stop is abort-only until the run's own finalizer has drained its work. */
  stopFromPanel(runId: string, reason?: string): void {
    const run = getRunById(runId);
    if (!run || run.owner !== "bridge" || run.ownerId !== this.id) return;
    run.controller.abort(reason);
    run.injectedQueue.length = 0;
    if (this.direct.run === run) {
      void this.direct
        .end()
        .catch((error: unknown) => log.warn("direct cleanup failed", String(error)));
    }
  }

  updateQueue(queue: QueuedRun[]): void {
    const mine = queue.filter((run) => run.owner === "bridge" && run.ownerId === this.id);
    const next = mine.map((run, index) => ({
      runId: run.id,
      conversationId: run.conversationId,
      position: index + 1,
      task: truncate(run.task, 160),
      owner: run.owner,
    }));
    if (this.queuedAnswer && !mine.some((run) => run.id === this.queuedAnswer?.id)) {
      const { question, choices } = this.queuedAnswer;
      this.queuedAnswer = null;
      // The reply was cancelled before it could run. The original question still needs an answer.
      applyQuestion(this.status, question, choices);
      this.publish({ type: "question", question, choices });
    }
    if (JSON.stringify(this.status.queue) === JSON.stringify(next)) return;
    this.status.queue = next;
    this.publish({ type: "queue", queue: next });
  }

  /** Session closure fences queued commands before waiting for the command lane to drain. */
  async close(): Promise<void> {
    this.closed = true;
    const run = getOwnerRun("bridge", this.id);
    if (run) this.stopFromPanel(run.id, BRIDGE_DISCONNECTED);
    const cancelled = listQueue().filter(
      (entry) => entry.owner === "bridge" && entry.ownerId === this.id,
    );
    await Promise.all([
      ...cancelled.map(cancelQueuedTask),
      this.serialize(async () => {
        await this.direct.end();
        await this.launched;
      }),
    ]);
  }

  private async ensureThread(): Promise<string> {
    const stored = await this.thread.get();
    if (stored) return stored;
    const id = crypto.randomUUID();
    await this.thread.set(id);
    return id;
  }

  private async answer(params: Record<string, unknown>, runId?: string): Promise<unknown> {
    this.requireCurrent(runId);
    if (this.status.state !== "question") {
      throw new BridgeError("no-question", "No question needs an answer. Use run to start a task.");
    }
    if (this.confirmation) {
      this.requireActive(runId);
      const { id, resolve } = this.confirmation;
      if (params.confirmationId !== id || typeof params.approve !== "boolean") {
        throw new BridgeError(
          "confirmation-required",
          "Ask the user first. Then call answer with the current confirmation_id and their decision (approve: true or false).",
        );
      }
      this.confirmation = null;
      this.resumeStatus();
      resolve({ approved: params.approve });
      return { resumed: true };
    }
    const pending = this.status.conversationId
      ? getPendingQuestion(this.status.conversationId)
      : undefined;
    const tabId = pending?.tabId ?? this.status.driving?.tabId;
    if (tabId === undefined || !(await chrome.tabs.get(tabId).catch(() => undefined))) {
      throw new BridgeError("tab-unavailable", i18n.t("errors.bridgeTabUnavailable"));
    }
    const result = await this.beginRun(
      { agent: params.agent, task: str(params.text), tabId },
      true,
    );

    if (this.status.runId === runId) {
      if (result.queued !== undefined && this.status.question) {
        this.queuedAnswer = {
          id: result.runId,
          question: this.status.question,
          choices: this.status.choices ?? undefined,
        };
      }
      this.resumeStatus();
    }
    return result;
  }

  private async beginRun(
    params: Record<string, unknown>,
    answerQuestion = false,
  ): Promise<{
    runId: string;
    conversationId: string;
    queued?: number;
  }> {
    const task = str(params.task);
    if (!task) throw new BridgeError("empty-task", "Enter a task, then try again.");
    const attached = images(params.images);
    if (attached?.some((image) => !image.startsWith("data:image/"))) {
      throw new BridgeError(
        "bad-image",
        "Send images as data URLs, such as data:image/png;base64,<base64>.",
      );
    }
    if (this.direct.open)
      throw new BridgeError("already-running", i18n.t("errors.alreadyRunningMCP"));
    const target = tabTarget(params);
    if (params.background === false) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        throw new BridgeError("tab-unavailable", i18n.t("errors.bridgeTabUnavailable"));
      }
      target.tabId = tab.id;
    }
    const conversationId = await this.ensureThread();
    const runId = crypto.randomUUID();
    const client = str(params.agent) || i18n.t("history.unknownAgent");
    await openAgentConversation(conversationId, client);
    await appendMessageTo(conversationId, {
      id: runId,
      role: "user",
      content: task,
      timestamp: Date.now(),
      ...(attached?.length ? { images: attached } : {}),
    });
    if (this.closed) {
      await recordTaskCancellation(conversationId, runId);
      throw staleRun();
    }
    const outcome = submitRun({
      id: runId,
      conversationId,
      owner: "bridge",
      ownerId: this.id,
      task,
      answerQuestion,
      launch: () => {
        this.queuedAnswer = null;
        this.status = newRunStatus(conversationId, runId);
        this.setActivity("run", client, runId, conversationId);
        this.publish({ type: "started", runId, conversationId });
        const running = this.launch(runId, conversationId, task, attached, target, answerQuestion);
        this.launched = running;
        void running.finally(() => {
          if (this.launched === running) this.launched = null;
        });
      },
    });
    if ("queued" in outcome) {
      const mine = listQueue().filter((run) => run.owner === "bridge" && run.ownerId === this.id);
      return { runId, conversationId, queued: mine.findIndex((run) => run.id === runId) + 1 };
    }
    return { runId, conversationId };
  }

  private async launch(
    runId: string,
    conversationId: string,
    task: string,
    images: string[] | undefined,
    target: ReturnType<typeof tabTarget>,
    answerQuestion: boolean,
  ): Promise<void> {
    const writer = new TranscriptWriter(conversationId);
    const emit = (event: Event) => {
      writer.apply(event);
      if (this.status.runId !== runId) return;
      const compact = applyStatusEvent(this.status, event);
      if (compact) this.publish(compact);
    };
    try {
      const result = await startAgentRun({
        runId,
        conversationId,
        owner: "bridge",
        ownerId: this.id,
        task,
        images,
        ...target,
        answerQuestion,
        onActionApproval: ({ action, site }) => {
          const run = getRunById(runId);
          if (!run || run.controller.signal.aborted) return Promise.resolve({ approved: false });
          return new Promise<PlanApprovalOutcome>((resolve) => {
            const id = crypto.randomUUID();
            const abort = () => {
              this.confirmation = null;
              resolve({ approved: false });
            };
            run.controller.signal.addEventListener("abort", abort, { once: true });
            this.confirmation = {
              id,
              resolve: (outcome) => {
                run.controller.signal.removeEventListener("abort", abort);
                resolve(outcome);
              },
            };
            const question = site ? `${action} (${site})` : action;
            applyQuestion(this.status, question, undefined, id);
            this.publish({ type: "question", question, confirmationId: id });
          });
        },
        emit,
        onAskUser: (question, choices) => {
          if (this.status.runId !== runId) return;
          applyQuestion(this.status, question, choices);
          this.publish({ type: "question", question, choices });
        },
      });
      if (!result.ok) emit({ type: "error", message: i18n.t("errors.alreadyRunningMCP") });
    } catch (error) {
      log.error("bridge run failed", { runId, error: String(error) });
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.clearActivity(runId);
    }
  }

  private async beginDirect(params: Record<string, unknown>): Promise<unknown> {
    if (
      this.status.state === "question" ||
      getOwnerRun("bridge", this.id) ||
      listQueue().some((run) => run.owner === "bridge" && run.ownerId === this.id)
    ) {
      throw new BridgeError("already-running", i18n.t("errors.alreadyRunningMCP"));
    }
    const goal = str(params.goal);
    if (!goal) throw new BridgeError("empty-task", "Enter a goal, then try again.");
    const conversationId = await this.ensureThread();
    if (this.closed) throw staleRun();
    const client = str(params.agent) || i18n.t("history.unknownAgent");
    try {
      const result = await this.direct.start(
        goal,
        client,
        {
          ...tabTarget(params),
          background: params.background !== false,
        },
        conversationId,
      );
      const run = this.direct.run;
      if (!run || this.closed) throw staleRun();
      this.status = newRunStatus(conversationId, run.id);
      this.setActivity("direct", client, run.id, conversationId);
      this.publish({ type: "started", runId: run.id, conversationId });
      await this.updateDriving();
      return { ...result, runId: run.id, conversationId };
    } catch (error) {
      await this.direct.end();
      throw error;
    }
  }

  private async updateDriving(): Promise<void> {
    const tabId = this.direct.drivenTab;
    if (tabId === null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      const driving = { tabId, windowId: tab.windowId, title: tab.title ?? "" };
      this.status.driving = driving;
      this.publish({ type: "driving", ...driving });
    } catch (error) {
      if (!(error instanceof Error) || !/^No tab with id: \d+\.?$/.test(error.message)) throw error;
      await this.direct.end();
    }
  }

  private requireCurrent(runId?: string): void {
    if (!runId || runId !== this.status.runId) throw staleRun();
  }

  private requireActive(runId?: string) {
    this.requireCurrent(runId);
    const run = runId ? getRunById(runId) : null;
    if (
      !run ||
      run.owner !== "bridge" ||
      run.ownerId !== this.id ||
      run.controller.signal.aborted
    ) {
      throw staleRun();
    }
    return run;
  }

  private async stop(runId?: string): Promise<unknown> {
    if (!runId) throw staleRun();
    const queued = listQueue().find(
      (run) => run.id === runId && run.owner === "bridge" && run.ownerId === this.id,
    );
    if (queued) {
      await cancelQueuedTask(queued);
      return { stopped: true, panelBusy: false };
    }
    if (this.status.runId === runId && this.status.state === "question" && !this.confirmation) {
      const conversationId = this.status.conversationId;
      this.status.state = "stopped";
      this.status.question = null;
      this.status.choices = null;
      this.status.finishedAt = Date.now();
      this.publish({ type: "done", stopped: true });
      if (conversationId) clearPendingQuestion(conversationId);
      return { stopped: true, panelBusy: false };
    }
    const run = this.requireActive(runId);
    this.stopFromPanel(run.id);
    if (this.direct.open) await this.direct.end();
    return { stopped: true, panelBusy: false };
  }

  private async capture(runId?: string): Promise<unknown> {
    const run = this.requireActive(runId);
    if (run.readsClosed) throw staleRun();
    const tabId = this.direct.drivenTab ?? this.status.driving?.tabId;
    if (tabId === undefined || tabId === null || tabOwner(tabId) !== run.id || !isAttached(tabId)) {
      throw new BridgeError("capture-failed", i18n.t("errors.noBridgeScreenshot"));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const read = Promise.race([
      Promise.all([screenshot(tabId), chrome.tabs.get(tabId)]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new BridgeError("capture-failed", i18n.t("errors.noBridgeScreenshot"))),
          5_000,
        );
      }),
    ]);
    run.pendingReads.add(read);
    try {
      const [dataUrl, tab] = await read;
      return { dataUrl, tabId, title: tab.title ?? "", url: tab.url ?? "", driven: true };
    } finally {
      if (timeout) clearTimeout(timeout);
      run.pendingReads.delete(read);
    }
  }

  private async newConversation(runId?: string): Promise<unknown> {
    if (this.status.runId || runId) this.requireCurrent(runId);
    if (
      (getOwnerRun("bridge", this.id) && !this.direct.open) ||
      listQueue().some((run) => run.owner === "bridge" && run.ownerId === this.id)
    ) {
      throw new BridgeError(
        "run-in-progress",
        "This chat has a task in progress. Stop it first, then start a new chat.",
      );
    }
    await this.direct.end();
    const conversationId = await this.thread.get();
    if (conversationId) clearPendingQuestion(conversationId);
    await this.thread.set(null);
    this.status = emptyStatus();
    return { ok: true };
  }

  private async compact(runId?: string): Promise<unknown> {
    if (this.status.runId || runId) this.requireCurrent(runId);
    const conversationId = await this.thread.get();
    if (!conversationId)
      throw new BridgeError(
        "nothing-to-compact",
        "This chat has no history yet. Start a task first.",
      );
    if (
      getActiveRun(conversationId) ||
      listQueue().some((run) => run.conversationId === conversationId)
    ) {
      throw new BridgeError(
        "run-in-progress",
        "This chat has a task in progress. Compact once it finishes.",
      );
    }
    const config = await getProviderFor((await getConversationMeta(conversationId))?.engine);
    if (!config) throw new Error(i18n.t("chat.hint.noProvider"));
    const resolved = await resolveProviderModel(await ensureProviderCredential(config));
    return (
      (await compactConversation(
        createProvider({ ...resolved, sessionId: conversationId }),
        conversationId,
        new AbortController().signal,
      )) ?? { nothing: true }
    );
  }

  private setActivity(
    mode: BridgeActive["mode"],
    client: string,
    runId: string,
    conversationId: string,
  ): void {
    this.active = { clientId: this.id, runId, conversationId, mode, client };
    this.onActivity();
  }

  private clearActivity(runId: string): void {
    if (this.active?.runId !== runId) return;
    this.active = null;
    this.onActivity();
  }

  private resumeStatus(): void {
    this.status.state = "running";
    this.status.question = null;
    this.status.confirmationId = null;
    this.status.choices = null;
    this.status.finishedAt = null;
    this.publish({ type: "resumed" });
  }

  private publish(event: CompactRunEvent): void {
    this.send({
      type: "event",
      clientId: this.id,
      runId: this.status.runId,
      conversationId: this.status.conversationId,
      event,
    });
  }
}

function staleRun(): BridgeError {
  return new BridgeError("stale-run", i18n.t("errors.staleBridgeRun"));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function args(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function images(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((image): image is string => typeof image === "string");
  return list.length ? list : undefined;
}

function tabTarget(params: Record<string, unknown>): {
  url?: string;
  tabId?: number;
  newTab?: boolean;
} {
  const url = str(params.url) || undefined;
  const tabId =
    typeof params.tabId === "number" && Number.isSafeInteger(params.tabId) && params.tabId >= 0
      ? params.tabId
      : undefined;
  const newTab = params.newTab === true;
  if (
    (params.tabId !== undefined && tabId === undefined) ||
    (tabId !== undefined && (newTab || url || params.background === false)) ||
    (params.background === false && (newTab || url))
  ) {
    throw new BridgeError(
      "bad-tab-target",
      "Choose one target: tab_id for an open tab, background: false for the current tab, or new_tab / url for a new tab.",
    );
  }
  return { url, tabId, newTab };
}
