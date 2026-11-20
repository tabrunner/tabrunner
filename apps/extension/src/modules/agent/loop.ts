import {
  defineAgent,
  type AgentEvent,
  type AgentHost,
  type AgentInput,
  type AgentMessage,
  type CallVerdict,
  type InputInbox,
  type InputReceipt,
  type LifecycleEvent,
  type QueuedInput,
  type RunOutcome,
} from "@providerkit/agents";
import {
  defineTool,
  ProviderError as CoreProviderError,
  withStreamRetry,
  type ErrorKind,
  type ImagePart,
  type Provider as CoreProvider,
  type ProviderChunk,
  type StreamOptions,
  type Tool,
  type ToolContext as CoreToolContext,
} from "@providerkit/core";
import type { BrowserDriver } from "@/modules/browser";
import type { ChatMessage, ChatProvider, ToolCall, UsageTick } from "@/modules/providers/types";
import { isRetryable, ProviderError } from "@/modules/providers/types";
import {
  asCoreProvider,
  fromCoreMessages,
  toCoreMessages,
  toImagePart,
} from "@/modules/providers/factory";
import { tokenCost } from "@/modules/providers/pricing";
import type { StepPayload, PlanApprovalPayload, PlanPayload } from "@/shared/protocol";
import { createLogger, truncate } from "@/lib/logger";
import { i18n, currentLanguageName } from "@/i18n";
import { loadAgentContext } from "@/modules/memory";
import { listSchedules } from "@/modules/schedule";
import { loadSkillsForRun, newlyApplicableSkills } from "@/modules/skills";
import type { McpRunSnapshot } from "@/modules/mcp";
import { MCP_TOOL_PREFIX } from "@/modules/mcp";
import type { RunRecorder } from "@/modules/walkthrough/recorder";
import type { JevConnection } from "@/modules/jev";
import { truncateTo } from "@/lib/format";
import {
  executeTool,
  formatDetail,
  formatSuccessSummary,
  landedHost,
  parsePlanPayload,
} from "./tools";
import type { RunGroup, ToolResult } from "./tools";
import type { RunOwner } from "./active-runs";
import { buildSystemPrompt, buildTaskMessage, buildToolDefs } from "./prompt";
import { confirmAction } from "./confirm-step";
import type { ConfirmAsk } from "./confirm-step";
import type { PreviousTab, RunMode, SubmitPage } from "./prompt";
import { COMPACT_SYSTEM } from "./compact";
import { DEFAULT_CONTEXT_WINDOW } from "@/modules/providers/context-window";

const log = createLogger("agent");

export const MAX_STEPS = 500;
const MAX_TOOL_CALLS = MAX_STEPS * 8;
const MAX_TREE_MODEL_CALLS = MAX_STEPS + 32;
const MAX_ACTIVE_MS = 2 * 60 * 60_000;
const MAX_ELAPSED_MS = 24 * 60 * 60_000;
const MAX_INLINE_BYTES = 50_000_000;
const TOOL_TIMEOUT_MS = 10 * 60_000;

const MAX_STREAM_ATTEMPTS = 3;
const MAX_BLIP_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 1000;
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_ATTACHED_IMAGES = 2;
const MAX_EMPTY_TURNS = 3;

const TEXT_ONLY_NUDGE =
  "Respond with a tool call, not plain text. If you just asked the user a question, call `ask_user` with that same question now. Written-out questions do not pause the run, so the user never got to answer. Otherwise make progress on the task: call snapshot if you need to see the page, or `done` if the task is complete.";

const NEAR_END_NUDGE =
  "You are near the end of your working budget. If you can wrap up meaningfully now, call `done` with your best summary of what you accomplished. If you genuinely need more work and have a concrete plan to finish, call `ask_user` to ask the user whether to continue. Describe what you have done so far and offer specific choices (for example, keep digging vs stop). Only ask if continuing is meaningfully better than stopping here.";

const ACTION_TOOLS = new Set([
  "delegate",
  "navigate",
  "go_back",
  "open_tab",
  "close_tab",
  "click",
  "type",
  "fill",
  "evaluate",
  "press_key",
  "scroll_down",
  "scroll_up",
]);

const READ_ONLY_TOOLS = new Set([
  "list_tabs",
  "switch_tab",
  "snapshot",
  "read_page_text",
  "find",
  "read_network_requests",
  "read_console_messages",
  "screenshot",
  "skill",
  "read_history",
  "ask_user",
  "done",
]);

const GATED_TOOLS = new Set([...ACTION_TOOLS, "schedule_task"]);

export function isGatedTool(name: string): boolean {
  return GATED_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX);
}

const PAGE_WORK_TOOLS = new Set(["click", "type", "fill", "press_key", "evaluate"]);
const PAGE_STATE_TOOLS = new Set(["click", "type", "fill", "press_key"]);
const NEW_PAGE_TOOLS = new Set(["navigate", "go_back", "open_tab", "switch_tab", "delegate"]);
const TOUCHES_PAGE = new Set([...PAGE_WORK_TOOLS, "navigate", "go_back"]);

const cancelledAfterFailure = (name: string) =>
  `Earlier action \`${name}\` in this turn failed. Its error is in that call's result. This call did not run. Re-observe the page before retrying.`;
const CANCELLED_PAGE_CHANGED =
  "The page moved after an earlier action this turn, so the refs you wrote this call with may no longer mean what they did. This call and the rest of the turn did not run. Call snapshot for fresh refs and continue from there.";

export interface PlanApprovalOutcome {
  approved: boolean;
  feedback?: string;
  allowSite?: boolean;
}

export interface LoopCallbacks {
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onStepStart?: (tool: string, args: Record<string, unknown>) => void;
  onStep?: (step: StepPayload) => void;
  onPlan?: (plan: PlanPayload) => void;
  onApprovedPlanChange?: (steps: string[] | null) => void;
  onPlanApproval?: (ask: PlanApprovalPayload) => Promise<PlanApprovalOutcome>;
  onInjected?: (id: string, text: string) => void;
  onUsage?: (usage: UsageTick) => void;
  onContextLimit?: (observedInput: number) => void;
  onError?: (message: string, kind?: ErrorKind) => void;
  onDone?: (summary?: string) => void;
  onAskUser?: (question: string, choices?: string[]) => void;
}

export interface LoopOptions {
  provider: CoreProvider | ChatProvider;
  driver: BrowserDriver;
  task: string;
  runId?: string;
  conversationId?: string;
  runGroup?: RunGroup;
  owner?: RunOwner;
  recorder?: RunRecorder;
  scheduleId?: string;
  jev?: JevConnection;
  autoApprovePlan?: boolean;
  mcp?: McpRunSnapshot;
  images?: string[];
  supportsImages?: boolean;
  previousTabs?: PreviousTab[];
  mode?: RunMode;
  submitPage?: SubmitPage;
  startUrl?: string;
  history?: ChatMessage[];
  standingPlan?: string[];
  contextWindow?: number;
  drainInjected?: () => { id: string; text: string }[];
  drainNotices?: () => string[];
  maxSteps?: number;
  modelId?: string;
  signal: AbortSignal;
  callbacks: LoopCallbacks;
}

function isCoreProvider(p: CoreProvider | ChatProvider): p is CoreProvider {
  return "createStream" in p && typeof p.createStream === "function";
}

function errorKindOf(err: unknown): ErrorKind | undefined {
  if (err instanceof ProviderError) return err.kind;
  if (err instanceof CoreProviderError) {
    return err.cause instanceof ProviderError ? err.cause.kind : err.kind;
  }
  return undefined;
}

function maxAttemptsFor(err: unknown): number {
  const kind = errorKindOf(err);
  return kind === "auth" || kind === "network" ? MAX_BLIP_ATTEMPTS : MAX_STREAM_ATTEMPTS;
}

function retryableForTabRunner(err: unknown): boolean {
  if (err instanceof ProviderError) return isRetryable(err);
  if (err instanceof CoreProviderError) {
    if (err.cause instanceof ProviderError) return isRetryable(err.cause);
    if (err.shouldRetry === false) return false;
    if (err.kind === "auth" || err.kind === "network") return true;
    if (err.kind === "timeout" || err.kind === "overload" || err.kind === "rate") {
      return err.retryAfterMs === undefined || err.retryAfterMs <= MAX_RETRY_WAIT_MS;
    }
    return (
      err.kind === "quota" &&
      err.retryAfterMs !== undefined &&
      err.retryAfterMs <= MAX_RETRY_WAIT_MS
    );
  }
  return isRetryable(err);
}

/**
 * Hold non-visible chunks (such as early usage frames) until visible output or
 * finish arrives, so an early usage frame before an in-band failure never
 * commits `withStreamRetry`.
 */
async function* holdNonVisibleUntilOutput(
  source: AsyncIterable<ProviderChunk>,
): AsyncGenerator<ProviderChunk> {
  let committed = false;
  const held: ProviderChunk[] = [];
  for await (const chunk of source) {
    const visible =
      chunk.type === "finish" ||
      (chunk.type === "delta" &&
        Boolean(chunk.content || chunk.reasoning || chunk.toolCalls?.length));
    if (!committed && !visible) {
      held.push(chunk);
      continue;
    }
    if (!committed) {
      committed = true;
      yield* held;
      held.length = 0;
    }
    yield chunk;
  }
  if (!committed) yield* held;
}

/** Wrap a CoreProvider with TabRunner's pre-output retry policy and retry step rows. */
function withTabRunnerRetry(
  base: CoreProvider,
  callbacks: LoopCallbacks,
  onTerminalError: (err: unknown) => void,
): CoreProvider {
  return {
    id: base.id,
    model: base.model,
    async *createStream(messages, tools, opts: StreamOptions = {}): AsyncGenerator<ProviderChunk> {
      const stream = withStreamRetry(
        (attemptSignal) =>
          holdNonVisibleUntilOutput(
            base.createStream(messages, tools, { ...opts, signal: attemptSignal }),
          ),
        {
          maxAttempts: MAX_BLIP_ATTEMPTS,
          baseDelayMs: BASE_BACKOFF_MS,
          maxDelayMs: MAX_RETRY_WAIT_MS,
          budgetMs: Infinity,
          signal: opts.signal,
          shouldRetry: (err, attempt) =>
            attempt < maxAttemptsFor(err) && retryableForTabRunner(err),
          onRetry: ({ error, attempt }) => {
            const max = maxAttemptsFor(error) - 1;
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`stream failed before any output, retrying (${attempt}/${max}):`, reason);
            callbacks.onStep?.({
              tool: "retry",
              summary: i18n.t("errors.retrying", { attempt, max }),
              detail: reason,
            });
          },
        },
      );
      try {
        yield* stream;
      } catch (err) {
        onTerminalError(err);
        throw err;
      }
    },
  };
}

/** Steering inbox over TabRunner's run-slot queues, polling between turns with recall. */
function createRunSlotInbox(opts: {
  drainInjected?: () => { id: string; text: string }[];
  drainNotices?: () => string[];
  hasCompletedTurn: () => boolean;
  onSteerAccepted: (id: string, text: string) => void;
}): InputInbox {
  const buffered = new Map<string, { id: string; text: string; isNotice: boolean }>();
  const delivered = new Set<string>();
  const consumed = new Set<string>();
  let noticeSeq = 0;

  return {
    poll({ limit, signal }) {
      signal.throwIfAborted();
      if (!opts.hasCompletedTurn()) return [];
      for (const note of opts.drainNotices?.() ?? []) {
        if (!note.trim()) continue;
        const id = `__notice_${++noticeSeq}`;
        log.info("run notice:", truncateTo(note, 120));
        buffered.set(id, { id, text: note, isNotice: true });
      }
      for (const item of opts.drainInjected?.() ?? []) {
        if (!item.text.trim() || buffered.has(item.id) || consumed.has(item.id)) continue;
        buffered.set(item.id, { id: item.id, text: item.text, isNotice: false });
      }
      const out: QueuedInput[] = [];
      let bytes = 0;
      for (const entry of buffered.values()) {
        if (consumed.has(entry.id)) continue;
        const size = entry.id.length + entry.text.length + 32;
        if (out.length >= limit.count || bytes + size > limit.bytes) break;
        bytes += size;
        out.push({ id: entry.id, content: entry.text });
      }
      return out;
    },
    acknowledge(receipts: readonly InputReceipt[], { signal }) {
      signal.throwIfAborted();
      for (const receipt of receipts) {
        const entry = buffered.get(receipt.id);
        if (!entry) continue;
        if (!delivered.has(receipt.id)) {
          delivered.add(receipt.id);
          if (!entry.isNotice) {
            log.info("injected mid-run message:", truncate(entry.text, 120));
            opts.onSteerAccepted(entry.id, entry.text);
          }
        }
        if (receipt.status === "consumed") {
          consumed.add(receipt.id);
          buffered.delete(receipt.id);
        }
      }
    },
  };
}

function toAgentHistory(history: ChatMessage[] | undefined): AgentMessage[] {
  if (!history?.length) return [];
  const out: AgentMessage[] = [];
  for (const m of toCoreMessages(history)) {
    if (m.role === "assistant") out.push(m);
    else if (m.role === "user" && (Array.isArray(m.content) || m.content.trim() !== "")) {
      out.push(m);
    }
  }
  return out;
}

function buildAgentInput(
  history: AgentMessage[],
  taskText: string,
  images: string[] | undefined,
): AgentInput {
  const imageParts = (images ?? []).map(toImagePart).filter((p): p is ImagePart => p !== undefined);
  const content: AgentMessage["content"] =
    imageParts.length > 0 ? [{ type: "text", text: taskText }, ...imageParts] : taskText;
  return history.length === 0 ? content : { messages: [...history, { role: "user", content }] };
}

function askChoices(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const choices = [
    ...new Set(raw.filter((c): c is string => typeof c === "string" && c.trim() !== "")),
  ];
  return choices.length > 0 ? choices : undefined;
}

/** Agent loop built on `@providerkit/agents` `defineAgent`. */
export async function runAgentLoop(opts: LoopOptions): Promise<ChatMessage[]> {
  const {
    driver,
    task,
    conversationId,
    runGroup,
    owner,
    scheduleId,
    recorder,
    images,
    supportsImages: supportsImagesOpt,
    previousTabs,
    mode,
    submitPage,
    startUrl,
    history,
    standingPlan,
    autoApprovePlan = false,
    contextWindow = DEFAULT_CONTEXT_WINDOW,
    drainInjected,
    drainNotices,
    maxSteps = MAX_STEPS,
    signal,
    callbacks: rawCallbacks,
  } = opts;

  const supportsImages = supportsImagesOpt ?? true;
  log.info("run started:", truncate(task, 120));

  const [context, schedules, runSkills, initial] = await Promise.all([
    loadAgentContext(startUrl),
    listSchedules(),
    loadSkillsForRun(startUrl),
    driver.snapshot(),
  ]);

  const delegateOn = opts.jev !== undefined;
  const toolDefs = buildToolDefs(
    context.memoryOn,
    supportsImages,
    runSkills.all.length > 0,
    recorder !== undefined,
    delegateOn,
    opts.mcp?.tools ?? [],
  );

  const systemPrompt = buildSystemPrompt(
    context,
    currentLanguageName(),
    supportsImages,
    schedules,
    runSkills.applicable,
    delegateOn,
    autoApprovePlan,
  );
  const taskMessage = buildTaskMessage(task, initial.pageContent, {
    previousTabs,
    mode,
    ...(submitPage ? { submitPage } : {}),
    ...(scheduleId ? { scheduleId } : {}),
    ...(standingPlan?.length ? { standingPlan } : {}),
  });

  const agentInput = buildAgentInput(toAgentHistory(history), taskMessage, images);

  let approvedPlan: PlanPayload | null = null;
  let standingApproval: string[] | null = standingPlan ?? null;
  let steeredSincePlan = false;
  let draftChecked = mode !== "adopted";
  const allowedSites = new Set<string>();
  let lastAsked: string[] | null = standingPlan ?? null;
  let batchTurn = -1;
  let batchCancelled: string | null = null;
  let batchPageChanged = false;
  let batchActed = false;
  let completedTurns = 0;
  let planRejected = false;
  let endedWithAsk: { question: string; choices?: string[] } | undefined;
  let lastInputTokens = 0;
  let lastProviderError: unknown;
  let warnedTextOnlyImages = false;

  const pendingPlanAsks = new Map<
    string,
    { plan: PlanPayload; ask: PlanApprovalPayload; needsApproval: boolean }
  >();
  const planCardEmittedFor = new Set<string>();
  const pendingConfirmAsks = new Map<string, ConfirmAsk[]>();
  const lastToolResult = new Map<string, ToolResult>();
  const turnToolCount = new Map<string, number>();
  const turnToolsSeen = new Map<string, number>();
  const emittedModelUsage = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  >();
  const announcedSkills = new Set(runSkills.applicable.map((s) => s.name));

  const callbacks: LoopCallbacks = {
    ...rawCallbacks,
    onUsage: (tick) => {
      if (tick.input > 0) lastInputTokens = tick.input;
      rawCallbacks.onUsage?.(tick);
    },
  };

  const baseCoreProvider: CoreProvider = isCoreProvider(opts.provider)
    ? opts.provider
    : asCoreProvider(opts.provider, "tabrunner", opts.modelId ?? "chat");
  const retriedProvider = withTabRunnerRetry(baseCoreProvider, callbacks, (err) => {
    lastProviderError = err;
  });

  const runStop = new AbortController();
  const combinedSignal = AbortSignal.any([signal, runStop.signal]);
  const modelId = opts.modelId ?? baseCoreProvider.model;

  const coreTools: Tool[] = toolDefs.map((def) => {
    const isStopping = def.name === "done" || def.name === "ask_user";
    return defineTool<Record<string, unknown>, unknown>({
      name: def.name,
      description: def.description,
      inputSchema: { ...def.params, type: "object" as const },
      isReadOnly: READ_ONLY_TOOLS.has(def.name),
      timeoutMs: TOOL_TIMEOUT_MS,
      async run(args: Record<string, unknown>, ctx: CoreToolContext) {
        const callId = ctx.callId ?? def.name;
        const operationId = typeof ctx.operationId === "string" ? ctx.operationId : callId;
        const reportCost =
          typeof ctx.reportCost === "function"
            ? (ctx.reportCost as (usd: number) => void)
            : undefined;
        const toolCall: ToolCall = { id: callId, name: def.name, args };

        const result = await executeTool(toolCall, driver, {
          conversationId,
          runGroup,
          owner,
          scheduleId,
          skills: runSkills.all,
          signal: ctx.signal,
          ...(opts.mcp ? { mcp: opts.mcp.handle } : {}),
          ...(opts.jev ? { jev: opts.jev } : {}),
          reportCost: (usd) => {
            reportCost?.(usd);
            callbacks.onUsage?.({ input: 0, output: 0, cost: usd });
          },
          ...(recorder ? { recorder } : {}),
        });
        lastToolResult.set(operationId, result);

        if (!result.ok) {
          log.warn(`tool ${def.name} failed:`, result.error);
          if (ACTION_TOOLS.has(def.name)) batchCancelled = cancelledAfterFailure(def.name);
          throw new Error(result.error ?? i18n.t("errors.failed", { error: "unknown" }));
        }

        if (ACTION_TOOLS.has(def.name)) await runGroup?.touch();
        if (PAGE_WORK_TOOLS.has(def.name)) batchActed = true;
        if (NEW_PAGE_TOOLS.has(def.name)) batchPageChanged = true;

        const modelOpId = operationId.replace(/\/tool\/\d+$/, "");
        const seen = (turnToolsSeen.get(modelOpId) ?? 0) + 1;
        turnToolsSeen.set(modelOpId, seen);
        if (PAGE_WORK_TOOLS.has(def.name) && seen < (turnToolCount.get(modelOpId) ?? 1)) {
          if (await driver.settle()) batchPageChanged = true;
        }

        if (def.name === "plan") {
          const plan = result.data as PlanPayload;
          if (!planCardEmittedFor.has(operationId)) callbacks.onPlan?.(plan);
          planCardEmittedFor.delete(operationId);
          const decision = ctx.decision as
            | { type: "approve" | "deny"; data?: { revision?: string } }
            | undefined;
          const revision = decision?.data?.revision;
          const standing = standingApproval;
          standingApproval = null;
          steeredSincePlan = false;

          if (revision) {
            approvedPlan = null;
            callbacks.onApprovedPlanChange?.(null);
            return { revision, note: i18n.t("plan.revisionNote") };
          }
          let note: string | undefined;
          if (approvedPlan && plan.current < approvedPlan.current) {
            note = i18n.t("plan.narrowedNote");
          } else if (!approvedPlan && standing && plan.steps.length < standing.length) {
            note = i18n.t("plan.shrunkNote", { count: standing.length });
          }
          approvedPlan = plan;
          callbacks.onApprovedPlanChange?.(plan.steps);
          return note ? { ...plan, note } : plan;
        }

        if (def.name === "ask_user") {
          const question = typeof args.question === "string" ? args.question : "";
          const choices = askChoices(args.choices);
          endedWithAsk = { question, choices };
          return { question, ...(choices ? { choices } : {}) };
        }
        if (def.name === "done") {
          return (result.data as { summary?: string })?.summary?.trim() ?? "";
        }

        const landed = landedHost(toolCall, result);
        const fresh =
          landed === null ? [] : newlyApplicableSkills(runSkills.all, landed, announcedSkills);
        for (const s of fresh) announcedSkills.add(s.name);
        const basePayload =
          result.data !== undefined && result.data !== null
            ? (result.data as Record<string, unknown>)
            : { ok: true };
        const finalPayload =
          fresh.length > 0
            ? {
                ...basePayload,
                new_skills: `${i18n.t("run.newSkills")} ${fresh
                  .map((s) => `${s.name}: ${truncateTo(s.description.replace(/\s+/g, " "), 120)}`)
                  .join("; ")}`,
              }
            : basePayload;

        if (result.images?.length && supportsImages) {
          const imgParts = result.images
            .map(toImagePart)
            .filter((p): p is ImagePart => p !== undefined);
          if (imgParts.length > 0) {
            return [{ type: "text", text: JSON.stringify(finalPayload) }, ...imgParts];
          }
        }
        return finalPayload;
      },
      summarize(output: unknown) {
        if (isStopping) {
          if (def.name === "done") return typeof output === "string" ? output : "";
          return (
            (output as { question?: string } | undefined)?.question?.trim() ||
            i18n.t("errors.taskComplete")
          );
        }
        return typeof output === "string" ? output : JSON.stringify(output);
      },
    });
  });

  const inbox =
    drainInjected || drainNotices
      ? createRunSlotInbox({
          drainInjected,
          drainNotices,
          hasCompletedTurn: () => completedTurns > 0,
          onSteerAccepted: (id, text) => {
            callbacks.onInjected?.(id, text);
            steeredSincePlan = true;
          },
        })
      : undefined;

  const host: AgentHost = {
    ...(inbox ? { inbox } : {}),
    priceModelCall({ usage, model }) {
      if (usage.reportedCostUsd !== undefined) return usage.reportedCostUsd;
      return (
        tokenCost(model || modelId, {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cachedInputTokens,
          cacheWrite: usage.cacheWriteTokens,
        }) ?? 0
      );
    },
    onContextLimit(limit) {
      const observed = limit.inputTokens ?? (lastInputTokens > 0 ? lastInputTokens : contextWindow);
      log.warn(`context window exceeded at ~${observed} tokens - compacting and retrying`);
      callbacks.onContextLimit?.(observed);
    },
    async screenCall(request, screenCtx): Promise<CallVerdict | undefined> {
      if (screenCtx.turn !== batchTurn) {
        batchTurn = screenCtx.turn;
        batchCancelled = null;
        batchPageChanged = false;
        batchActed = false;
      }
      if (batchCancelled) return { cancel: batchCancelled };

      const { name } = request.call;
      const args = request.arguments;
      if (isGatedTool(name) && !approvedPlan) {
        log.warn(`tool ${name} blocked - no approved plan yet`, args);
        const detail = i18n.t("errors.planGateModel");
        callbacks.onStep?.({
          tool: name,
          summary: i18n.t("errors.planGate"),
          ok: false,
          args,
          detail,
        });
        return { refuse: JSON.stringify({ error: detail }) };
      }

      if (PAGE_STATE_TOOLS.has(name)) {
        const grew =
          batchActed && !batchPageChanged
            ? await driver.snapshot().then(
                (s) => s.newRefs > 0,
                () => true,
              )
            : false;
        if (batchPageChanged || grew) {
          log.info(`${name} cancelled - the page moved earlier this turn`);
          batchCancelled = CANCELLED_PAGE_CHANGED;
          return { cancel: CANCELLED_PAGE_CHANGED };
        }
      }
      return undefined;
    },
    async needsApproval(request): Promise<boolean> {
      const { name } = request.call;
      const args = request.arguments;
      if (name === "plan") {
        const cached = pendingPlanAsks.get(request.operationId);
        if (cached) return cached.needsApproval;
        const plan = parsePlanPayload(args);
        if (!plan) return false;
        const baseline = approvedPlan !== null || standingApproval !== null;
        const askNeeded = baseline
          ? args.deviates_from_approved === true && !steeredSincePlan
          : !autoApprovePlan;
        const reason =
          baseline && typeof args.deviation_reason === "string" ? args.deviation_reason.trim() : "";
        const ask: PlanApprovalPayload = {
          ...plan,
          reapproval: baseline,
          ...(lastAsked ? { previous: lastAsked } : {}),
          ...(reason ? { deviationReason: reason } : {}),
        };
        pendingPlanAsks.set(request.operationId, { plan, ask, needsApproval: askNeeded });
        return askNeeded;
      }

      if (autoApprovePlan && isGatedTool(name)) {
        const existing = pendingConfirmAsks.get(request.operationId);
        if (existing) return existing.length > 0;
        const asks: ConfirmAsk[] = [];
        if (!draftChecked && TOUCHES_PAGE.has(name)) {
          draftChecked = true;
          const draft = await driver.holdsDraft().catch(() => false);
          if (draft) asks.push({ action: i18n.t("plan.confirmDraft") });
        }
        const commit = await confirmAction({ id: request.call.id, name, args }, driver);
        if (commit && !(commit.site && allowedSites.has(commit.site))) asks.push(commit);
        pendingConfirmAsks.set(request.operationId, asks);
        return asks.length > 0;
      }
      return false;
    },
    prepareRequest(draft) {
      return {
        scope: {
          actorId: owner ?? "panel",
          resource: { id: conversationId ?? draft.id, version: "1" },
          expiresAt: Date.now() + MAX_ELAPSED_MS,
        },
        ...(draft.call?.call.name === "plan"
          ? {
              ask: {
                type: "approval" as const,
                approveSchema: {
                  type: "object" as const,
                  properties: { revision: { type: "string" } },
                },
              },
            }
          : {}),
      };
    },
    async answerNow(request) {
      const call = request.call;
      if (!call) return { type: "approve" };

      if (call.call.name === "plan") {
        const pending = pendingPlanAsks.get(call.operationId);
        if (!pending) return { type: "approve" };
        planCardEmittedFor.add(call.operationId);
        callbacks.onPlan?.(pending.plan);
        lastAsked = pending.plan.steps;
        const outcome = (await callbacks.onPlanApproval?.(pending.ask)) ?? { approved: true };
        if (signal.aborted) return { type: "stop" };
        if (!outcome.approved) {
          const revision = outcome.feedback?.trim() || undefined;
          if (!revision) {
            log.info("plan rejected by user");
            planRejected = true;
            runStop.abort();
            return { type: "stop" };
          }
          log.info("plan returned for revision:", truncate(revision, 120));
          return { type: "approve", data: { revision } };
        }
        return { type: "approve" };
      }

      const asks = pendingConfirmAsks.get(call.operationId) ?? [];
      const base = approvedPlan ?? { steps: [], current: 0 };
      for (const { action, site } of asks) {
        const outcome = (await callbacks.onPlanApproval?.({
          ...base,
          reapproval: false,
          action,
          ...(site ? { site } : {}),
        })) ?? { approved: true };
        if (signal.aborted) return { type: "stop" };
        if (!outcome.approved) {
          const note = outcome.feedback?.trim();
          log.info(`${call.call.name} declined by user`);
          callbacks.onStep?.({
            tool: call.call.name,
            summary: i18n.t("errors.stepDeclined"),
            ok: false,
            args: call.arguments,
            detail: action,
          });
          batchCancelled = cancelledAfterFailure(call.call.name);
          return {
            type: "deny",
            message: JSON.stringify({
              error: i18n.t("errors.stepDeclinedModel", {
                note: note ? `Their note: ${note} ` : "",
              }),
            }),
          };
        }
        if (site && outcome.allowSite) allowedSites.add(site);
      }
      return { type: "approve" };
    },
    beforeTool() {},
  };

  const agent = defineAgent({
    id: "tabrunner-browser-agent",
    version: "1",
    instructions: systemPrompt,
    provider: retriedProvider,
    supportsVision: supportsImages,
    toolHistory: { keepImages: MAX_ATTACHED_IMAGES },
    tools: coreTools,
    runFirst: ["plan"],
    stopAtTools: ["done", "ask_user"],
    stopOnlyAtTools: { nudge: TEXT_ONLY_NUDGE },
    finish: { emptyTurns: MAX_EMPTY_TURNS - 1, nearEnd: NEAR_END_NUDGE },
    requests: { onePerTurn: true },
    compaction: {
      identity: "tabrunner-compact-v1",
      contextWindow,
      retryOnContextLimit: true,
      summarize: { provider: retriedProvider, instructions: COMPACT_SYSTEM, maxTokens: 4096 },
    },
    limits: {
      turns: maxSteps,
      toolCalls: MAX_TOOL_CALLS,
      activeMs: MAX_ACTIVE_MS,
      elapsedMs: MAX_ELAPSED_MS,
      parallelTools: 1,
      inlineBytes: MAX_INLINE_BYTES,
    },
    treeLimits: {
      maxParallel: 1,
      maxChildren: 0,
      maxDepth: 0,
      modelCalls: MAX_TREE_MODEL_CALLS,
      elapsedMs: MAX_ELAPSED_MS,
    },
  });

  const onLifecycle = async (event: LifecycleEvent) => {
    if (event.type === "model_end") {
      if (!event.operationId.includes("/compaction/")) completedTurns += 1;
      turnToolCount.set(event.operationId, event.turn.message.toolCalls?.length ?? 0);
      turnToolsSeen.set(event.operationId, 0);
      if (event.turn.finishReason === "length") {
        callbacks.onStep?.({ tool: "warn", summary: i18n.t("errors.outputLimit") });
      }
      if (event.operationId.includes("/compaction/")) {
        callbacks.onStep?.({
          tool: "compact",
          summary: i18n.t("compact.folded", { count: 1 }),
          ok: true,
        });
      }
    } else if (event.type === "tool_start") {
      const { name, id } = event.request.call;
      if (name !== "plan") callbacks.onStepStart?.(name, event.request.arguments);
      await recorder?.beforeAction({ id, name, args: event.request.arguments });
    } else if (event.type === "tool_end") {
      const { name, id } = event.request.call;
      const recorded = lastToolResult.get(event.request.operationId);
      lastToolResult.delete(event.request.operationId);
      if (recorded) {
        await recorder?.afterAction(
          { id, name, args: event.request.arguments },
          recorded.ok,
          recorded.data,
        );
        if (name !== "plan") {
          callbacks.onStep?.({
            tool: name,
            summary: recorded.ok
              ? formatSuccessSummary(name, recorded.data)
              : i18n.t("errors.failed", { error: recorded.error }),
            ok: recorded.ok,
            args: event.request.arguments,
            detail: formatDetail(name, recorded, event.request.arguments),
            images: recorded.images,
          });
        }
      }
    }
  };

  const onEvent = (event: AgentEvent) => {
    if (event.type === "model_chunk") {
      const { chunk } = event;
      if (chunk.type === "delta") {
        if (chunk.reasoning) callbacks.onReasoning?.(chunk.reasoning);
        if (chunk.content) callbacks.onToken?.(chunk.content);
      }
      if (chunk.usage) {
        const prev = emittedModelUsage.get(event.operationId) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        };
        const dInput = Math.max(0, chunk.usage.inputTokens - prev.input);
        const dOutput = Math.max(0, chunk.usage.outputTokens - prev.output);
        const dCacheRead = Math.max(0, chunk.usage.cachedInputTokens - prev.cacheRead);
        const cacheWrite = chunk.usage.cacheWriteTokens;
        const dCacheWrite =
          cacheWrite !== undefined ? Math.max(0, cacheWrite - prev.cacheWrite) : undefined;
        const reportedCost = chunk.usage.reportedCostUsd;
        const dCost =
          reportedCost !== undefined ? Math.max(0, reportedCost - prev.cost) : undefined;
        if (dInput > 0 || dOutput > 0 || (dCost !== undefined && dCost > 0)) {
          emittedModelUsage.set(event.operationId, {
            input: Math.max(prev.input, chunk.usage.inputTokens),
            output: Math.max(prev.output, chunk.usage.outputTokens),
            cacheRead: Math.max(prev.cacheRead, chunk.usage.cachedInputTokens),
            cacheWrite:
              cacheWrite !== undefined ? Math.max(prev.cacheWrite, cacheWrite) : prev.cacheWrite,
            cost: reportedCost !== undefined ? Math.max(prev.cost, reportedCost) : prev.cost,
          });
          callbacks.onUsage?.({
            input: dInput,
            output: dOutput,
            cacheRead: dCacheRead,
            ...(dCacheWrite !== undefined ? { cacheWrite: dCacheWrite } : {}),
            ...(dCost !== undefined ? { cost: dCost } : {}),
          });
        }
      }
    } else if (
      event.type === "images_omitted" &&
      !warnedTextOnlyImages &&
      images?.length &&
      !supportsImages
    ) {
      warnedTextOnlyImages = true;
      callbacks.onStep?.({ tool: "warn", summary: i18n.t("errors.textOnlyImages") });
    }
  };

  const reportError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = errorKindOf(err);
    if (kind) log.warn("run failed:", msg);
    else log.error("run failed:", msg);
    callbacks.onError?.(kind ? msg : i18n.t("errors.providerError", { message: msg }), kind);
  };

  let outcome: RunOutcome<string>;
  try {
    outcome = await agent.run(agentInput, {
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(conversationId ? { providerSessionId: conversationId } : {}),
      signal: combinedSignal,
      host,
      onEvent,
      onLifecycle,
    });
  } catch (e) {
    if (signal.aborted) {
      callbacks.onDone?.();
      return [];
    }
    reportError(lastProviderError ?? e);
    return [];
  }

  const wire = fromCoreMessages(
    outcome.history.map((m) => {
      if (m.role === "user") {
        return {
          role: "user" as const,
          content:
            typeof m.content === "string" ? m.content : m.content.filter((p) => p.type !== "media"),
        };
      }
      return m;
    }),
  );

  const asked: { question: string; choices?: string[] } | undefined = endedWithAsk;
  if (planRejected) {
    callbacks.onDone?.(i18n.t("errors.planRejected"));
  } else if (signal.aborted || outcome.status === "cancelled") {
    callbacks.onDone?.();
  } else if (outcome.status === "completed") {
    if (asked) {
      log.info("run paused on ask_user");
      callbacks.onAskUser?.(asked.question, asked.choices);
      callbacks.onDone?.();
    } else {
      const summary = outcome.output.trim() || i18n.t("errors.taskComplete");
      log.info("run done:", truncate(summary, 120));
      callbacks.onDone?.(summary);
    }
  } else if (outcome.status === "limited") {
    if (outcome.limit === "outputTokens") {
      const lastModel = outcome.snapshot.models.at(-1);
      const fallback =
        lastModel?.status === "completed" ? lastModel.turn.message.content.trim() : "";
      callbacks.onDone?.(fallback || i18n.t("errors.taskComplete"));
    } else {
      callbacks.onDone?.(i18n.t("errors.stepBudgetExhausted"));
    }
  } else if (outcome.status === "failed") {
    if (outcome.error.code === "empty_output") {
      log.warn(`model went quiet ${MAX_EMPTY_TURNS} turns in a row - ending the run`);
      callbacks.onError?.(i18n.t("errors.emptyTurns", { count: MAX_EMPTY_TURNS }));
    } else if (outcome.error.code === "model_failed" && lastProviderError) {
      reportError(lastProviderError);
    } else {
      log.error("run failed:", outcome.error.message);
      callbacks.onError?.(outcome.error.message);
    }
  } else {
    callbacks.onDone?.();
  }

  return wire;
}
