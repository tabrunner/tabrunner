import { i18n } from "@/i18n";
import { getActiveRun, releaseRun } from "@/modules/agent/active-runs";
import { compactConversation } from "@/modules/agent/compact";
import { cancelQueued, listQueue, onBoardChanged, submitRun } from "@/modules/agent/run-queue";
import { startAgentRun } from "@/modules/agent/start-run";
import { captureVisibleTab } from "@/modules/browser";
import {
  appendMessageTo,
  getConversationMeta,
  openAgentConversation,
} from "@/modules/conversation";
import { bridgeThread } from "./config";
import { DirectSession } from "./direct";
import { TranscriptWriter } from "@/modules/conversation/transcript";
import {
  createProvider,
  ensureProviderCredential,
  getActiveProvider,
  getProviderFor,
  resolveProviderModel,
} from "@/modules/providers";
import { providerDisplayName } from "@/modules/providers/presets";
import { credentialStatus, isOAuthProvider } from "@/modules/providers/status";
import { createLogger, truncate } from "@/lib/logger";
import type { BridgeActive, Event } from "@/shared/protocol";
import type { BridgeProviderInfo, BridgeStatus, DaemonMessage, ExtensionMessage } from "./protocol";
import { applyQuestion, applyStatusEvent, emptyStatus, newRunStatus } from "./status";
import { BridgeSocket } from "./ws-client";

const log = createLogger("bridge");

/**
 * The MCP bridge: a WS client to the local daemon that lets external AI clients
 * drive the same agent loop as the panel. Owns the dedicated MCP conversation
 * (never the panel's), the per-run transcript writer, and the compact run
 * status the daemon serves via getStatus. All run mechanics live in
 * startAgentRun — this is only the adapter between WS commands and it.
 */
export class Bridge {
  /**
   * @param onActivity Fired whenever "an external client is working in the
   * browser" changes — the worker broadcasts it to every open panel, so the
   * panel can show the same run that is already blinking the driven tab.
   */
  constructor(private readonly onActivity?: (active: BridgeActive | null) => void) {}

  private socket: BridgeSocket | null = null;
  private writer: TranscriptWriter | null = null;
  private status: BridgeStatus = emptyStatus();
  /** Who is in the browser right now — the panel's run_active answer. */
  private active: BridgeActive | null = null;
  /** Direct browser control, for a client that drives instead of delegating. */
  private readonly direct = new DirectSession(() => this.clearActivity());

  /** Synchronous — the socket registers MV3 event listeners in this same turn. */
  start(): void {
    this.socket = new BridgeSocket(
      (msg) => this.onMessage(msg),
      () => this.onOpen(),
    );
    this.socket.start();
    // Mirror the run queue into the compact stream: get_status lists what is
    // waiting, and a long-polling client wakes when the line moves.
    onBoardChanged((board) => {
      this.status.queue = board.queue.map((q, i) => ({
        position: i + 1,
        task: truncate(q.task, 160),
        owner: q.owner,
      }));
      this.socket?.send({ type: "event", event: { type: "queue", queue: this.status.queue } });
    });
  }

  private onOpen(): void {
    this.socket?.send({
      type: "hello",
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
  }

  private onMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case "ping":
        this.socket?.send({ type: "pong" });
        break;
      case "request":
        void this.handleRequest(msg.requestId, msg.method, msg.params);
        break;
    }
  }

  private async handleRequest(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case "sync":
        this.respond(requestId, this.status);
        break;
      case "providerInfo":
        this.respond(requestId, await providerInfo());
        break;
      case "run":
        await this.beginRun(
          requestId,
          str(params.task),
          images(params.images),
          str(params.agent),
          str(params.url) || undefined,
          params.background !== false,
        );
        break;
      case "answer":
        await this.answer(requestId, str(params.text));
        break;
      case "steer":
        this.steer(requestId, str(params.text));
        break;
      case "stop":
        await this.stopRun(requestId);
        break;
      case "screenshot":
        await this.screenshot(requestId);
        break;
      // Direct driving: the daemon exposes a conventional browser_* tool per
      // verb, but they all arrive here as one method — the wire stays small
      // while the MCP surface stays the shape models already know.
      case "browserStart":
        await this.guard(requestId, async () => {
          const client = str(params.agent) || i18n.t("history.unknownAgent");
          const result = await this.direct.start(str(params.goal), client);
          // Only after the session actually opened — a refusal (already running,
          // no tab) must not claim the browser.
          this.setActivity("direct", client);
          return result;
        });
        break;
      case "browserAct":
        await this.guard(requestId, () => this.direct.act(str(params.tool), args(params.args)));
        break;
      case "browserEnd":
        await this.direct.end();
        this.respond(requestId, { ok: true });
        break;
      case "newConversation":
        await this.newConversation(requestId);
        break;
      case "compact":
        await this.compactThread(requestId);
        break;
      default:
        this.fail(requestId, "unknown-method", `Unknown bridge method: ${method}`);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────

  private async beginRun(
    requestId: string,
    task: string,
    attached?: string[],
    agent?: string,
    url?: string,
    background = true,
  ): Promise<void> {
    if (!task) {
      this.fail(requestId, "empty-task", "Task can't be empty.");
      return;
    }
    if (attached?.some((img) => !img.startsWith("data:image/"))) {
      this.fail(
        requestId,
        "bad-image",
        "Images must be data URLs — data:image/png;base64,<base64>. Pass the bytes base64-encoded.",
      );
      return;
    }
    if (this.direct.open) {
      // A direct session holds the slot but runs no loop — there is nothing to
      // queue a task behind that the client could watch, so it stays a refusal.
      this.fail(requestId, "already-running", this.alreadyRunningText());
      return;
    }
    const conversationId = await this.ensureThread();
    const runId = crypto.randomUUID();
    const client = agent || i18n.t("history.unknownAgent");
    await openAgentConversation(conversationId, client);
    // The task must be stored before the run starts — even a queued one: history
    // is rebuilt from the transcript at launch, whenever the slot frees.
    await appendMessageTo(conversationId, {
      id: crypto.randomUUID(),
      role: "user",
      content: task,
      timestamp: Date.now(),
      ...(attached?.length ? { images: attached } : {}),
    });
    const outcome = submitRun({
      conversationId,
      owner: "bridge",
      task,
      launch: () => {
        log.info("bridge run starting", { runId, task: truncate(task, 120) });
        // Claim the status slot only now — a queued run must not clobber the
        // mirror of the run actually in flight. Stamp the thread with the
        // client that drove it, for history and the panel's band alike.
        this.status = newRunStatus(conversationId, runId);
        this.setActivity("run", client);
        // The daemon's mirror needs the same reset: without it a queued run's
        // events fold into the previous run's terminal state.
        this.socket?.send({
          type: "event",
          event: { type: "started", runId, conversationId },
        });
        void this.launch(conversationId, task, attached, url, background);
      },
    });
    if ("queued" in outcome) {
      log.info("bridge run queued", {
        runId,
        position: outcome.queued,
        task: truncate(task, 120),
      });
      this.respond(requestId, { runId, conversationId, queued: outcome.queued });
      return;
    }
    this.respond(requestId, { runId, conversationId });
  }

  /** answer() is run with a different word for the model, not a different engine. */
  private async answer(requestId: string, text: string): Promise<void> {
    if (this.status.state !== "question") {
      this.fail(
        requestId,
        "no-question",
        "No question is awaiting an answer. Use run to start a new task.",
      );
      return;
    }
    await this.beginRun(requestId, text);
  }

  private steer(requestId: string, text: string): void {
    if (!text) {
      this.fail(requestId, "empty-text", "Steer message can't be empty.");
      return;
    }
    // A direct session holds the slot but runs no loop, so there is nothing to
    // steer — the message would land in a queue nothing drains.
    const run = getActiveRun();
    if (this.direct.open || !run || run.owner !== "bridge") {
      this.fail(requestId, "no-run", "No task is in progress to steer. Start one with run.");
      return;
    }
    run.injectedQueue.push({ id: crypto.randomUUID(), text });
    this.respond(requestId, { ok: true });
  }

  private async stopRun(requestId: string): Promise<void> {
    const run = getActiveRun();
    const mine = run?.owner === "bridge";
    // Queued bridge runs are this client's too — cancel them first, or stopping
    // the active one would simply pump the next into the slot.
    let cancelled = 0;
    for (const q of listQueue()) {
      if (q.owner !== "bridge" || !cancelQueued(q.id)) continue;
      cancelled++;
      // A cancelled queued run never produces an event — leave the breadcrumb
      // itself, or the thread reads as if the task vanished.
      await appendMessageTo(q.conversationId, {
        id: crypto.randomUUID(),
        role: "step",
        tool: "interrupted",
        content: i18n.t("errors.runCancelled"),
        timestamp: Date.now(),
      });
    }
    this.stopFromPanel();
    // Stop is not an error — a no-op stop still succeeds. But say which no-op
    // it was: a panel run left untouched must never read as "browser is idle".
    this.respond(requestId, {
      stopped: mine || cancelled > 0,
      panelBusy: !mine && run?.owner === "panel",
    });
  }

  /**
   * The panel's Stop routed here — same mechanics as the WS stop, no response.
   * A direct session holds the slot too, so stopping it closes the session, or
   * the slot stays claimed by something that believes it is still driving.
   */
  stopFromPanel(): void {
    if (this.direct.open) {
      void this.direct.end();
      return;
    }
    const run = getActiveRun();
    if (run?.owner === "bridge") {
      run.controller.abort();
      run.injectedQueue.length = 0;
      releaseRun(run);
    }
  }

  /**
   * Who an external client is in the browser right now — the panel's answer to
   * query_run, and null once the browser is the user's again.
   */
  get activity(): BridgeActive | null {
    return this.active;
  }

  private setActivity(mode: BridgeActive["mode"], client: string): void {
    this.active = { mode, client };
    this.onActivity?.(this.active);
  }

  private clearActivity(): void {
    if (!this.active) return;
    this.active = null;
    this.onActivity?.(null);
  }

  /** What the browser looks like right now — the model's eyes between steps. */
  private async screenshot(requestId: string): Promise<void> {
    try {
      // A direct session drives the tab it opened on; a delegated run reports
      // its own. Either way "driven" must mean "this is the tab being worked".
      const driving = this.direct.drivenTab ?? this.status.driving?.tabId;
      const shot = await captureVisibleTab(this.status.driving?.windowId);
      this.respond(requestId, { ...shot, driven: shot.tabId === driving });
    } catch (e) {
      this.fail(requestId, "capture-failed", e instanceof Error ? e.message : String(e));
    }
  }

  private async newConversation(requestId: string): Promise<void> {
    // Only our own run — active or queued — blocks the reset: a panel run has
    // nothing to do with this thread, and refusing over it would be a dead end
    // with no way out.
    if (
      !this.direct.open &&
      (getActiveRun()?.owner === "bridge" || listQueue().some((q) => q.owner === "bridge"))
    ) {
      this.fail(
        requestId,
        "run-in-progress",
        "This chat has a task in progress — stop it first, then start the new one.",
      );
      return;
    }
    // A direct session is its own thread; resetting means closing it.
    await this.direct.end();
    await bridgeThread.set(null);
    this.status = emptyStatus();
    this.respond(requestId, { ok: true });
  }

  /** The daemon's compact tool — folds this thread's history into a summary. */
  private async compactThread(requestId: string): Promise<void> {
    const conversationId = await bridgeThread.get();
    if (!conversationId) {
      this.fail(
        requestId,
        "nothing-to-compact",
        "This chat has no history yet — it starts on the first task.",
      );
      return;
    }
    // The same constraint as the panel's /compact, keyed on the CONVERSATION
    // rather than the owner: a live run's wire conversation is the run's, and a
    // transcript summary appended mid-run lands after messages that run is
    // still writing — which is true whoever started it.
    if (getActiveRun()?.conversationId === conversationId) {
      this.fail(
        requestId,
        "run-in-progress",
        "This chat has a task in progress — compact once it finishes.",
      );
      return;
    }
    try {
      // The thread's own engine writes the thread's summary.
      const config = await getProviderFor((await getConversationMeta(conversationId))?.engine);
      if (!config) throw new Error(i18n.t("chat.hint.noProvider"));
      const resolved = await resolveProviderModel(await ensureProviderCredential(config));
      const result = await compactConversation(
        createProvider(resolved),
        conversationId,
        // One short call the client is holding a request open for.
        new AbortController().signal,
      );
      // The daemon relays this to its client — a null must still answer.
      this.respond(requestId, result ?? { nothing: true });
    } catch (e) {
      this.fail(requestId, "compact-failed", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Runs an op that throws its own oriented message (the direct session's do)
   * and answers the daemon either way — an exception here would otherwise
   * leave the client waiting out its request timeout for no reason.
   */
  private async guard(requestId: string, op: () => Promise<unknown>): Promise<void> {
    try {
      this.respond(requestId, await op());
    } catch (e) {
      this.fail(requestId, "direct-failed", e instanceof Error ? e.message : String(e));
    }
  }

  // ── Run plumbing ──────────────────────────────────────────────────

  /** The MCP thread's id — one conversation until newConversation resets it.
   *  Read from storage, so a suspended, reloaded or updated worker resumes the
   *  same thread instead of starting the client over on a blank one. */
  private async ensureThread(): Promise<string> {
    const stored = await bridgeThread.get();
    if (stored) return stored;
    const id = crypto.randomUUID();
    await bridgeThread.set(id);
    return id;
  }

  private async launch(
    conversationId: string,
    task: string,
    images?: string[],
    url?: string,
    background = true,
  ): Promise<void> {
    this.writer = new TranscriptWriter(conversationId);
    // submitRun launches this only with the slot already free — acquireRun
    // inside startAgentRun is the same synchronous turn, so it cannot conflict.
    const result = await startAgentRun({
      conversationId,
      owner: "bridge",
      task,
      images,
      url,
      adoptCurrentTab: background ? undefined : true,
      emit: (event) => this.onRunEvent(event),
      onAskUser: (question, choices) => this.onQuestion(question, choices),
    });
    if (!result.ok) {
      // Unreachable through the queue (see above) — keep the failure visible
      // rather than silent if that ever changes.
      log.error("bridge run lost the slot it was launched with");
      this.onRunEvent({ type: "error", message: this.alreadyRunningText() });
    }
  }

  /** Every run event: persist it, fold it into status, forward the compact form. */
  private onRunEvent(event: Event): void {
    this.writer?.apply(event);
    const compact = applyStatusEvent(this.status, event);
    if (compact) this.socket?.send({ type: "event", event: compact });
    // done/error is the last event of a run — the next one opens its own writer.
    // The run is no longer in the browser either, so the panel band clears.
    if (event.type === "done" || event.type === "error") {
      this.writer = null;
      this.clearActivity();
    }
  }

  /**
   * ask_user is run-terminating: the question becomes the run's closing state
   * and answer() continues the thread. The writer stays open — the loop's own
   * `done` still follows, and its summary belongs in the transcript exactly as
   * it does for a panel run.
   */
  private onQuestion(question: string, choices?: string[]): void {
    applyQuestion(this.status, question, choices);
    this.socket?.send({ type: "event", event: { type: "question", question, choices } });
  }

  // ── Plumbing ──────────────────────────────────────────────────────

  private respond(requestId: string, result: unknown): void {
    this.socket?.send({ type: "response", requestId, ok: true, result } satisfies ExtensionMessage);
  }

  private fail(requestId: string, code: string, message: string): void {
    this.socket?.send({
      type: "response",
      requestId,
      ok: false,
      error: { code, message },
    } satisfies ExtensionMessage);
  }

  /** Oriented already-running text naming where the run is and how to stop it.
   *  Only called with the slot held (a direct session is bridge-owned, so the
   *  MCP wording covers the null case that can't happen here). */
  private alreadyRunningText(): string {
    return getActiveRun()?.owner === "panel"
      ? i18n.t("errors.alreadyRunningPanel")
      : i18n.t("errors.alreadyRunningMCP");
  }
}

/**
 * Whether TabRunner has a model to think with, for health to answer before a
 * task is sent. Read live rather than cached at connect: a user who signs in
 * while the daemon is already up must not still read as unconfigured.
 */
async function providerInfo(): Promise<BridgeProviderInfo> {
  const provider = await getActiveProvider();
  if (!provider) return { name: null, ready: false, auth: null, model: null };
  return {
    name: providerDisplayName(provider),
    ready: credentialStatus(provider) === "connected",
    auth: isOAuthProvider(provider.id) ? "subscription" : "key",
    model: provider.model ?? null,
  };
}

/** Wire params are unknown until proven otherwise — the daemon is not trusted input. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Tool arguments arrive as an opaque object — take it only if it is one. */
function args(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function images(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === "string");
  return list.length > 0 ? list : undefined;
}
