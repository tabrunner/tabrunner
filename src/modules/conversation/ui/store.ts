import { create } from "zustand";
import { i18n } from "@/i18n";
import type {
  BridgeActive,
  Command,
  DrivingPayload,
  Event,
  PanelMessage,
  PlanApprovalPayload,
} from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import type { Message, AgentStatus } from "../types";
import type { ConversationMeta } from "../conversations";
import { runBoardItem } from "@/modules/agent/run-queue";
import type { RunBoard } from "@/modules/agent/run-queue";
import {
  appendMessageFresh,
  appendMessageTo,
  recordEngine,
  deleteConversation,
  getActiveId,
  getMessages,
  listConversations,
  MAX_MESSAGES,
  renameConversation,
  setActiveConversation,
  watchActiveConversation,
  watchConversations,
} from "../conversations";
import { closingSummary } from "../transcript";
import { toolVerbKey } from "./tool-labels";
import type { PastedText } from "./paste-collapse";
import { isRestrictedUrl } from "@/modules/browser";
import { runModePref } from "@/lib/prefs";
import { engineOf, engineProvider } from "@/modules/providers/engine";
import { useProvidersStore } from "@/modules/providers/ui";
import type { ConversationEngine } from "@/modules/providers/types";
import type { RunMode } from "@/lib/prefs";

export interface ConversationState {
  messages: Message[];
  /** Stored transcripts, most recently touched first — powers the history list */
  conversations: ConversationMeta[];
  /** Open conversation; null until the first message of a fresh one is stored */
  activeId: string | null;
  status: AgentStatus;
  streamingText: string;
  /** Model reasoning stream for the current run (display-only, flushed at the next step or turn end) */
  reasoningText: string;
  /** Epoch ms when the open reasoning segment began — powers its "for 3m 48s" clock */
  reasoningStartedAt: number | null;
  /** Cumulative token usage for the current/last run. `cost` is the running
   *  dollar estimate — absent until a call prices, absent forever when the
   *  model isn't in the pricing table (unknown is not free). */
  usage: { input: number; output: number; cost?: number };
  /** Epoch ms when the current run started (drives the elapsed display) */
  runStartedAt: number | null;
  /** Epoch ms when it finished — keeps the summary line up after the run ends */
  runEndedAt: number | null;
  /** The last run ended on a user halt — the settled band says "Stopped", never "Done". */
  runStopped: boolean;
  /** A plan revision was just sent and the revised plan has not arrived — the
   *  band names the gap ("Revising the plan…") instead of a generic verb, so a
   *  note that takes a minute to redraft never reads as unsent. */
  replanning: boolean;
  /** This panel's own last dispatch — labels the queued chip, and tells a
   *  dispatch-and-forget approval (panel auto-closes) from a hand-opened one. */
  lastRun: { task: string; images?: string[]; background?: boolean } | null;
  /** Where the next submitted task drives — background tab or this page. */
  runMode: RunMode;
  /** Id of the in-flight tool's live row (never persisted) */
  pendingStepId: string | null;
  /** Id of this run's plan card — updates rewrite it rather than stacking copies */
  planMsgId: string | null;
  /** The running task is documenting itself — the band shows REC while it is. */
  recording: boolean;
  /** A proposed plan parked on the user's answer — the run resumes on approve, ends on reject. */
  planApproval: PlanApprovalPayload | null;
  /** This run's plan has the user's yes — the walk-away gate. Closing the panel
   *  before it strands the approval prompt on an OS notification. */
  planApproved: boolean;
  /** Messages typed mid-run, waiting for the next tool boundary. */
  queued: { id: string; text: string }[];
  /** Joined queued text waiting to auto-run once the current run fully unwinds (a stop redirect). */
  pendingSend: string | null;
  /** The composer's text, so a recalled queue or an ending run can hand text back to it. */
  draft: string;
  /** Collapsed pastes — token in the input, content spliced back in on send. */
  pastedTexts: PastedText[];
  /** A removed collapse teaches this draft to paste inline — the fold is only a surprise once. */
  collapseDisabled: boolean;
  /** The tab the current run is driving; null when idle. */
  drivingTab: DrivingPayload | null;
  /** An external client working in the browser (a bridge run or direct session) */
  bridgeActive: BridgeActive | null;
  /** The ambient run state — what runs/queues anywhere, widget-fed. */
  board: RunBoard;
  /** This panel's own submission waiting in the serial queue. */
  queuedRun: { id: string; position: number; task: string } | null;
  /** When the compaction in flight started, null when none is — a second
   *  /compact while one runs is a no-op. The timestamp, not a flag: the live
   *  row counts the wait out loud, the way the run band does. */
  compactingSince: number | null;
  /** A slash command parked until this conversation goes quiet — the one class
   *  of command that cannot just fire, because it costs a model call and writes
   *  the transcript a live run is still writing. The composer card is its
   *  receipt; the drain fires it the moment nothing here is running. */
  deferred: { name: string; run: () => void } | null;
  /**
   * A pick made before this conversation exists. The panel's fresh thread has
   * no id until its first message lands, so a "this chat only" pick has nothing
   * to pin to yet — it waits here and is written the moment the thread is born.
   */
  draftEngine: ConversationEngine | null;
  /** Input tokens the last turn actually sent — the real context size, straight
   *  from the provider's own usage. Cumulative `usage.input` is the sum of every
   *  turn and says nothing about how full the window is. */
  contextTokens: number;

  connect: () => void;
  disconnect: () => void;
  sendTask: (task: string, images?: string[]) => void;
  /** A local, display-only note (slash-command results) — rendered in the
   *  transcript, never persisted, never part of the model's history. */
  note: (content: string) => void;
  /** Summarize the conversation so far — /compact, and the context-error CTA.
   *  `resume` re-runs the failed task once the summary lands: the CTA's promise
   *  is "compact and carry on", one click. */
  compact: (opts?: { resume?: boolean }) => void;
  /** Take back the fold while it is still summarizing — Esc, and the live row's
   *  own control. The worker holds the abort handle; this only asks. */
  cancelCompact: () => void;
  /**
   * Land on a conversation somebody else opened — the shared slot moved. Same
   * switch as `openConversation` without the write that caused it; the composer
   * survives, because another window changing the subject must not eat a half
   * typed message.
   */
  followActive: (id: string | null) => void;
  /** Park a command until nothing is running here (see `deferred`). */
  deferCommand: (name: string, run: () => void) => void;
  /** Drop the parked command — the card's ×. */
  cancelDeferred: () => void;
  queueMessage: (text: string) => void;
  unqueueMessage: (id: string) => void;
  /** Cancel this panel's still-waiting queued run. */
  cancelQueuedRun: () => void;
  /** Cancel any panel-owned waiting run — the run board's per-row cancel. */
  cancelQueuedById: (id: string) => void;
  /** ↑-arrow recall: the newest queued message goes back to the composer. */
  recallQueued: () => void;
  /**
   * Point this conversation at a provider / model / effort. One patch at a
   * time, as the picker and the slash commands issue them: naming a provider
   * adopts that provider's own defaults, naming a model or effort refines the
   * pick in force.
   *
   * Writes through to the stored default as well, so "default" always means
   * your last deliberate pick — unless `thisChatOnly`, the ⌥ gesture, which
   * scopes it to this thread and leaves every future one alone.
   */
  setEngine: (patch: Partial<ConversationEngine>, thisChatOnly?: boolean) => void;
  setDraft: (text: string) => void;
  setRunMode: (target: RunMode) => void;
  /** Stash a collapsed paste's content behind its token. */
  addPastedText: (entry: PastedText) => void;
  /** Fresh draft after a send — the fold is fair game again. */
  clearPastedTexts: () => void;
  retry: () => void;
  stop: () => void;
  /** Answer a parked plan prompt — the loop resumes on approve, unwinds on reject. */
  approvePlan: () => void;
  rejectPlan: () => void;
  /** Send a parked plan back with changes — the model replans and asks again. */
  revisePlan: (feedback: string) => void;
  /** Start a fresh transcript — the current one stays in history */
  newConversation: () => void;
  openConversation: (id: string) => void;
  removeConversation: (id: string) => void;
  /** Names a conversation by hand — clearing it lets the next message re-derive one. */
  renameConversation: (id: string, title: string) => void;
}

/**
 * The engine pick in force for the thread the panel is showing: what that
 * conversation is pinned to, or — before its first message gives it an id —
 * what the picker chose while waiting. Undefined means nothing is pinned and
 * the stored default answers.
 *
 * A selector over stored values only: it must never build a fresh object, or
 * every consumer would re-render on every unrelated store change.
 */
export function pinOf(s: ConversationState): ConversationEngine | undefined {
  if (s.activeId === null) return s.draftEngine ?? undefined;
  return s.conversations.find((c) => c.id === s.activeId)?.engine;
}

/**
 * The board's record of a run live on the thread this panel is showing — the
 * run that is HERE without being ours to stream. `status` cannot answer this:
 * a panel that reopened onto its own background run reads idle, and so does
 * every panel showing a schedule's or the bridge's run, which broadcast to no
 * panel at all. Four surfaces asked it in the same breath (the walk-away, the
 * band, the composer, Esc-to-stop) and each kept its own copy of the question.
 *
 * A selector over stored values only: it hands back the board's own entry or
 * nothing — never a fresh object, which would re-render every consumer on
 * every unrelated store change.
 */
export function boardRunHere(s: ConversationState): RunBoard["running"] {
  return s.activeId !== null && s.board.running?.conversationId === s.activeId
    ? s.board.running
    : undefined;
}

/** Is a run working on THIS conversation — ours in flight, or the board's? */
export function runsHere(s: ConversationState): boolean {
  return s.status === "running" || boardRunHere(s) !== undefined;
}

let port: chrome.runtime.Port | null = null;
/** Distinguishes "panel closed on purpose" from the worker dropping the port. */
let intentionalDisconnect = false;
/** Panel → worker heartbeat: any port traffic resets the MV3 worker's idle timer,
 *  so long tool calls and slow reasoning streams can't kill it mid-run. */
let pingTimer: ReturnType<typeof setInterval> | null = null;
/** Storage watch on the conversation index — background appends land here too. */
let unwatchConversations: (() => void) | null = null;
/** Storage watch on the run board — the widget's state, mirrored here. */
let unwatchBoard: (() => void) | null = null;
let unwatchActive: (() => void) | null = null;
/** A send between "the user pressed Enter" and "the message is stored". The
 *  follow stands aside for it: the send resolves the thread it lands in from
 *  what this panel shows, and another window moving that out from under it
 *  would file the message under the thread the user just left. */
let sending = false;
/** Did this run stream any prose? Governs done-summary dedup, never its display. */
let sawAssistantText = false;
/** The user flipped the run mode already — the stored read must not land on
 *  top of a choice made while it was still in flight. */
let runModeTouched = false;
/** Dispatch-and-forget's close handshake: the panel closes on the first event
 *  back (proof the command landed), with a fallback if none ever comes. */
let closeOnFirstEvent = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePanelClose(): void {
  closeOnFirstEvent = true;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), 1500);
}

function cancelPanelClose(): void {
  closeOnFirstEvent = false;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function makeMsg(role: Message["role"], content: string, extra?: Partial<Message>): Message {
  return { id: crypto.randomUUID(), role, content, timestamp: Date.now(), ...extra };
}

/**
 * What Retry resends: the transcript's newest user message — the failed task
 * sits right above the error it ended in. Read from the transcript rather than
 * panel state, so a reopened panel still offers it (lastRun dies with the
 * close, and the "rate limit resets in 4 hours" retry happens after one).
 * Nothing about where it runs travels with it: every run works the tab the user
 * is on, and the retry is a fresh send with a fresh answer to that.
 */
export function retryTargetFrom(messages: Message[]): { task: string; images?: string[] } | null {
  const last = messages.findLast((m) => m.role === "user");
  if (!last) return null;
  return {
    task: last.content,
    ...(last.images?.length ? { images: last.images } : {}),
  };
}

// The dedup helper lives in the background-safe transcript writer — both the
// panel and the bridge close runs the same way.
export { closingSummary };

/**
 * Screenshots the panel is still holding. Storage strips them outright
 * (stripTransientImages) — the panel keeps a few so a just-finished step's
 * drill-down can show what the agent saw, but a base64 screenshot decodes to
 * megabytes of bitmap and a long run takes dozens. Past this the thumbnail
 * goes and the row keeps its summary, which is exactly what a reopened
 * conversation shows anyway.
 */
const MAX_PANEL_IMAGES = 6;

/**
 * The panel's own copy of the transcript, bounded the way storage already
 * bounds its own.
 *
 * Without this the live list grew without limit while a run worked — every
 * step, every thought, every screenshot — so a long run made the panel heavier
 * than the very same conversation reopened, which loads the capped 100 and no
 * images at all. The cap is shared with storage so the two agree; the
 * screenshot sweep is the panel's alone, since storage keeps none.
 */
export function capMessages(list: Message[]): Message[] {
  const capped = list.length > MAX_MESSAGES ? list.slice(-MAX_MESSAGES) : list;
  let budget = MAX_PANEL_IMAGES;
  let stripped: Message[] | null = null;
  for (let i = capped.length - 1; i >= 0; i--) {
    const msg = capped[i];
    // A user's own attachment is the subject of their task and always stays —
    // the same rule the wire's image pruning follows.
    if (!msg?.images?.length || msg.role === "user") continue;
    if (budget > 0) {
      budget -= msg.images.length;
      continue;
    }
    stripped ??= [...capped];
    const withoutImages = { ...msg };
    delete withoutImages.images;
    stripped[i] = withoutImages;
  }
  return stripped ?? capped;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  /**
   * Resolves with the message's conversation id once stored — awaited only
   * where ordering matters. Where the message lands is the conversation the
   * panel is SHOWING, never the shared active slot: between "New conversation"
   * (slot → null) and this write, a pill or notification click can re-point
   * that slot at another thread, and a read here would file the message under
   * it — the panel would adopt the id, keep rendering the live stream, and the
   * other thread's transcript would materialize at run end.
   */
  const pushMsg = (msg: Message): Promise<string> => {
    set({ messages: capMessages([...get().messages, msg]) });
    // A fresh conversation is created by the first append — adopt its id.
    const activeId = get().activeId;
    const write = activeId === null ? appendMessageFresh(msg) : appendMessageTo(activeId, msg);
    return write.then((id) => {
      if (get().activeId !== id) set({ activeId: id });
      // The thread now exists, so a pick that was waiting for it can land —
      // before the run that this same message is about to start reads it.
      const draftEngine = get().draftEngine;
      if (draftEngine) {
        set({ draftEngine: null });
        return recordEngine(id, draftEngine).then(() => id);
      }
      return id;
    });
  };

  /** Display-only append — run events persist through the shared writer. */
  const pushDisplay = (msg: Message): void => {
    set({ messages: capMessages([...get().messages, msg]) });
  };

  /** A compaction armed to re-run the failed task on success — the id of the
   *  user message it would resend, so a newer message disarms it. */
  let resumeAfterCompact: string | null = null;

  /** Transcript-independent state — reset whenever the panel switches transcripts. */
  const resetRun = () => ({
    streamingText: "",
    reasoningText: "",
    reasoningStartedAt: null,
    status: "idle" as AgentStatus,
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    runStopped: false,
    replanning: false,
    lastRun: null,
    pendingStepId: null,
    planMsgId: null,
    planApproval: null,
    planApproved: false,
    recording: false,
    queued: [],
    pendingSend: null,
    draftEngine: null,
    draft: "",
    pastedTexts: [],
    collapseDisabled: false,
    drivingTab: null,
    // A deferral is scoped to the conversation it was typed in — /compact folds
    // whatever is open when it fires, so it must not survive a switch.
    deferred: null,
    // Per-conversation measurements: another chat's fill is not this chat's.
    compactingSince: null,
    contextTokens: 0,
  });

  /**
   * Thinking, prose and tool calls are three kinds of segment, and each closes
   * the ones already open — so a run reads in the order it happened: think,
   * say, act, say again. Holding prose across the whole run instead put every
   * aside the model made into one block under every row it was said between:
   * the work stacked at the top, the narration at the bottom, and neither
   * explaining the other.
   *
   * Because each flushes the other, at most one is ever non-empty — which is
   * why the flush pairs below can run in either order.
   */
  const flushReasoning = () => {
    const reasoning = get().reasoningText.trim();
    const startedAt = get().reasoningStartedAt;
    if (reasoning) {
      pushDisplay(
        makeMsg(
          "reasoning",
          reasoning,
          startedAt ? { elapsed: Date.now() - startedAt } : undefined,
        ),
      );
    }
    set({ reasoningText: "", reasoningStartedAt: null });
  };

  const flushStreaming = () => {
    const text = get().streamingText.trim();
    if (text) {
      sawAssistantText = true;
      pushDisplay(makeMsg("assistant", text));
    }
    set({ streamingText: "" });
  };

  /** A run that ends with a tool in flight must not leave its row spinning. */
  const settleLive = (msgs: Message[]) => msgs.map((m) => (m.live ? { ...m, live: false } : m));

  /**
   * The one run-end transition — error, done, and a lost port all land here.
   * runStartedAt survives so the summary line can still say how long it went.
   */
  const settleRun = (status: AgentStatus) => {
    set((st) => ({
      messages: settleLive(st.messages),
      streamingText: "",
      reasoningText: "",
      reasoningStartedAt: null,
      status,
      runEndedAt: Date.now(),
      // "Did THIS panel dispatch the run in flight?" is a question two callers
      // need now that every panel sees every run — the port-lost write and
      // approvePlan's auto-close both key on it. Kept past its run it answers
      // yes for a run somebody else started. Nothing reads it after the end:
      // the queued chip and the auto-close are both mid-run, and Retry reads
      // the transcript on purpose (see retryTargetFrom).
      lastRun: null,
      pendingStepId: null,
      planMsgId: null,
      planApproval: null,
      drivingTab: null,
      queuedRun: null,
      planApproved: false,
      // The worker clears this too; doing it here covers a panel that
      // reconnected mid-run and never saw the recording event.
      recording: false,
      replanning: false,
    }));
  };

  /** Recall a text into the composer, preserving anything already there. */
  const mergeIntoDraft = (text: string) => {
    const draft = get().draft.trimEnd();
    return [draft, text].filter(Boolean).join("\n");
  };

  /** Unconsumed queue returns to the composer — an ending run must not eat typed text. */
  const recallQueue = () => {
    const q = get().queued;
    if (q.length === 0) return;
    set({
      queued: [],
      draft: mergeIntoDraft(q.map((x) => x.text).join("\n")),
      collapseDisabled: false,
    });
  };

  /**
   * Fire the parked command once this conversation is quiet. "Quiet" is stricter
   * than "the run ended": a stop redirect and a queued run are both a next run
   * already committed, and a /compact landing between them would summarize a
   * story about to continue. The card just stays up until they clear.
   */
  const drainDeferred = () => {
    const s = get();
    if (!s.deferred || runsHere(s) || s.pendingSend !== null || s.queuedRun) return;
    const { run } = s.deferred;
    set({ deferred: null });
    run();
  };

  /** A stop's pending redirect that errored instead of unwinding cleanly returns to the composer. */
  const returnPending = () => {
    const pending = get().pendingSend;
    if (pending === null) return;
    set({ pendingSend: null, draft: mergeIntoDraft(pending), collapseDisabled: false });
  };

  const startRun = (
    p: chrome.runtime.Port,
    conversationId: string,
    task: string,
    images?: string[],
  ) => {
    sawAssistantText = false;
    // Persistence is the worker's job now (it owns the transcript writer — the
    // panel may close right after submit); this store only renders.
    set({
      status: "running",
      streamingText: "",
      reasoningText: "",
      reasoningStartedAt: null,
      usage: { input: 0, output: 0 },
      runStartedAt: Date.now(),
      runEndedAt: null,
      runStopped: false,
      replanning: false,
      // Walking away is the user's mode, not the run's — the worker is never
      // told, because it changes nothing about how the run works. It is kept
      // here for the one thing it decides: whether approving the plan takes the
      // panel with it (see approvePlan).
      lastRun: {
        task,
        ...(images?.length ? { images } : {}),
        ...(get().runMode === "background" ? { background: true } : {}),
      },
      pendingStepId: null,
      // A new run draws its own card — never revives the last run's checklist.
      planMsgId: null,
      planApproval: null,
      planApproved: false,
      recording: false,
    });
    p.postMessage({
      type: "run",
      // The run's home is where its task message just landed — carried here so
      // the worker never re-derives it from the shared active slot, which a
      // pill or notification click can re-point mid-flight.
      conversationId,
      task,
      ...(images?.length ? { images } : {}),
    } satisfies Command);
  };

  /**
   * Send a task. It is stamped with the panel's active tab — the tab the run
   * adopts, watched or not. Guarded against the stop redirect: while
   * pendingSend is set, a user's Enter must not start a third run mid-handoff —
   * the pending send fires from the done handler.
   */
  const sendTask = async (task: string, images?: string[]) => {
    if (get().pendingSend !== null) return;
    // A run in flight steers instead (ChatInput routes there) — but when our
    // own submission is only waiting in the queue, a new one joins the line.
    if (get().status === "running" && !get().queuedRun) return;
    // The port dies with the worker — reconnect lazily instead of eating the task.
    let p: chrome.runtime.Port;
    try {
      p = attach();
    } catch {
      pushMsg(makeMsg("error", i18n.t("chat.reloaded")));
      return;
    }
    // From here to the stored message this panel's thread is fixed: the tab
    // query below is an await, and a slot moved in another window during it
    // would file the user's message under the thread they just left — the
    // "conversation switched itself" bug, now remotely triggerable.
    sending = true;
    // The message is anchored to the tab it was sent from — the run adopts that
    // same tab in either mode. The panel queries its own window here (the
    // send-time fact), while the background's own query stays the authority on
    // what the run actually drives. No stamp for a page Chrome forbids: the run
    // opens a tab of its own there, and a chrome:// chip under the message
    // would name a tab nothing ever drove.
    let tab: Message["tab"];
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.url && !isRestrictedUrl(active.url)) {
        tab = {
          title: active.title ?? "",
          url: active.url,
          ...(active.favIconUrl ? { favIconUrl: active.favIconUrl } : {}),
        };
      }
    } catch {
      // No stamp — the run still gets its tab from the background.
    }
    // Stored BEFORE the run starts: the worker builds this run's history by
    // reading the transcript, so a fire-and-forget write would race it and
    // cost the model the exchange it is being asked to continue.
    const conversationId = await pushMsg(
      makeMsg("user", task, { ...(images?.length ? { images } : {}), ...(tab ? { tab } : {}) }),
    );
    sending = false;
    startRun(p, conversationId, task, images);
    // The panel stays up through the plan: a background run's FIRST act is to
    // read the page and ask you to approve what it intends to do, and closing
    // before that turns the approval into an OS notification you have to click
    // your way back from. Dispatch-and-forget starts at approvePlan, where the
    // work actually becomes unattended.
  };

  const handleEvent = (event: Event) => {
    if (closeOnFirstEvent) {
      // Never close on something the user still has to see: an immediate
      // failure, or a replan that re-opens the gate before the panel is gone.
      if (event.type === "error" || event.type === "plan_approval") cancelPanelClose();
      else if (
        event.type === "run_queued" ||
        event.type === "driving" ||
        event.type === "step_start"
      ) {
        cancelPanelClose();
        window.close();
        return;
      }
    }
    switch (event.type) {
      case "driving":
        // The event payload IS the chip's data — see DrivingPayload in protocol.
        // A queued run's first driving event means the wait is over.
        set({ drivingTab: event, queuedRun: null });
        break;

      case "run_queued":
        // The submission is waiting in the serial queue — ChatInput says where.
        set({
          queuedRun: { id: event.id, position: event.position, task: get().lastRun?.task ?? "" },
        });
        break;

      case "run_active":
        set({ bridgeActive: event.active });
        break;

      case "recording":
        // Arming happens mid-run, whenever the model gets to the `document`
        // call — so the band cannot infer it from the run starting.
        set({ recording: event.on });
        break;

      case "artifact": {
        flushReasoning();
        flushStreaming();
        // The run's deliverable. Display-only here: the worker owns persistence,
        // and this is the same message it is writing to the transcript.
        pushDisplay(
          makeMsg("artifact", event.title, {
            artifact: {
              recordingId: event.recordingId,
              title: event.title,
              frames: event.frames,
              status: event.status,
              sites: event.sites,
            },
          }),
        );
        break;
      }

      case "token":
        flushReasoning();
        set({ streamingText: get().streamingText + event.text });
        break;

      case "reasoning":
        flushStreaming();
        set({
          reasoningText: get().reasoningText + event.text,
          // The first delta of a segment starts its clock.
          reasoningStartedAt: get().reasoningStartedAt ?? Date.now(),
        });
        break;

      case "step_start": {
        flushReasoning();
        flushStreaming();
        const key = toolVerbKey(event.tool);
        const msg = makeMsg("step", key ? `${i18n.t(key)}…` : "…", {
          tool: event.tool,
          args: event.args,
          live: true,
        });
        // Live rows are in-memory only — persisted once the tool finishes.
        set({ messages: capMessages([...get().messages, msg]), pendingStepId: msg.id });
        break;
      }

      case "step": {
        flushReasoning();
        flushStreaming();
        const settled: Partial<Message> = {
          content: event.summary,
          ok: event.ok,
          args: event.args,
          detail: event.detail,
          images: event.images,
          live: false,
        };
        const pending = get().pendingStepId;
        if (pending) {
          // Settle the live row in place — persistence is the writer's job now.
          set({
            messages: get().messages.map((m) => (m.id === pending ? { ...m, ...settled } : m)),
            pendingStepId: null,
          });
        } else {
          pushDisplay(makeMsg("step", event.summary, { tool: event.tool, ...settled }));
        }
        break;
      }

      case "plan": {
        flushReasoning();
        flushStreaming();
        const plan = { steps: event.steps, current: event.current };
        const existing = get().planMsgId;
        if (existing) {
          // Rewritten in place, so the card stays where the agent first drew it
          // instead of a new copy sliding in on every completed step.
          set({
            messages: get().messages.map((m) => (m.id === existing ? { ...m, ...plan } : m)),
          });
        } else {
          const msg = makeMsg("plan", "", plan);
          set({ planMsgId: msg.id });
          pushDisplay(msg);
        }
        break;
      }

      case "queued_steers":
        // The worker's answer on reconnect — its queue is the authority, so this
        // replaces rather than merges. Any card the panel still shows is in it.
        set({ queued: event.items });
        break;

      case "injected":
        // The loop consumed a queued message at a tool boundary — the pending
        // line becomes a real transcript entry in the order the model saw it.
        set({ queued: get().queued.filter((q) => q.id !== event.id) });
        pushDisplay(makeMsg("user", event.text));
        break;

      case "plan_approval": {
        // The loop is parked until the user answers — the plan card above
        // already shows what is being asked; this arms the approval card. A
        // fresh gate means no approved plan is in force (reapproval included).
        // The revised plan has arrived, so the "Revising…" band yields to it.
        set({
          planApproval: {
            steps: event.steps,
            current: event.current,
            reapproval: event.reapproval,
            previous: event.previous,
            deviationReason: event.deviationReason,
          },
          planApproved: false,
          replanning: false,
        });
        break;
      }

      case "plan_answered":
        // Answered somewhere — here, or in another window. The panel that
        // clicked has already disarmed its own card (which is what keeps a
        // double-click from answering the NEXT gate); this is how the others
        // learn, and it settles the walk-away for all of them at once.
        set({
          planApproval: null,
          planApproved: event.approved,
          // Only a revision replans. A bare rejection ends the run, and saying
          // "Revising the plan…" would promise a card that is never coming.
          replanning: !event.approved && event.feedback !== undefined,
        });
        // The note the plan went back with, drawn wherever the card was. The
        // panel that sent it persisted it; this is display only, so it reaches
        // the windows that were watching without writing the transcript twice.
        if (event.feedback) pushDisplay(makeMsg("user", event.feedback));
        break;

      case "usage":
        // Running totals, so this sets rather than adds — which is also what
        // lets one of these bring a panel that joined mid-run fully up to date.
        set({
          usage: {
            input: event.input,
            output: event.output,
            ...(event.cost !== undefined ? { cost: event.cost } : {}),
          },
          // A different measurement, not a slice of the one above: the last
          // turn's input IS how full the window is right now, and it drops back
          // down when the run folds its own history.
          ...(event.contextTokens > 0 ? { contextTokens: event.contextTokens } : {}),
        });
        break;

      case "compacted": {
        set({
          compactingSince: null,
          // The fold shrank the replay by exactly this much, so the gauge moves
          // the moment the work lands instead of sitting on a number describing
          // a request that will never be sent again. An estimate until the next
          // turn reports real usage and overwrites it — the run's own overhead
          // (system prompt, tools, the page snapshot) is untouched by a fold.
          contextTokens: Math.max(0, get().contextTokens - (event.before - event.after)),
        });
        // The summary lands in STORAGE, written by the worker — and the panel
        // watches the run board, not the transcript, so with no run in flight
        // nothing would tell it to look. Without this the card only appeared
        // once the next message started a run. This event is that signal.
        const conversationId = get().activeId;
        if (conversationId) {
          void getMessages(conversationId).then((messages) => {
            if (get().activeId === conversationId) set({ messages: capMessages(messages) });
            // The context-error CTA armed this: compact, then carry on. Fires
            // only when the failed task is still the newest thing said and
            // nothing has started since — otherwise the user moved on while
            // the summarizer ran. Resumed after the refetch so the resumed run
            // builds its history from the transcript the summary is now in.
            const resumeId = resumeAfterCompact;
            resumeAfterCompact = null;
            if (
              resumeId !== null &&
              get().activeId === conversationId &&
              get().status !== "running" &&
              get().messages.findLast((m) => m.role === "user")?.id === resumeId
            ) {
              get().retry();
            }
          });
        }
        break;
      }

      case "compact_failed":
        set({ compactingSince: null });
        // No summary, no resume — retrying into the same wall helps no one.
        resumeAfterCompact = null;
        // "Nothing to compact" is an answer, not a failure — it arrives as the
        // same quiet note every other command result does.
        pushDisplay(
          makeMsg(
            "step",
            event.nothing === true
              ? event.message
              : i18n.t("commands.compact.failed", { message: event.message }),
          ),
        );
        break;

      case "error": {
        // Flush any partial stream first — it must not dangle as a ghost bubble.
        flushReasoning();
        flushStreaming();
        recallQueue();
        // A stop redirect must never auto-fire into an error — hand it back.
        returnPending();
        pushDisplay(
          makeMsg("error", event.message, { kind: event.kind, unexpected: event.unexpected }),
        );
        settleRun("error");
        // A failed run is a finished one — and a context overflow is the very
        // case where the parked /compact is what the user needs next.
        drainDeferred();
        break;
      }

      case "done": {
        flushReasoning();
        flushStreaming();
        // Same marker the writer persists — the halt is part of the transcript,
        // so it must appear now and still be there on reopen. A failure aborts
        // the controller too, and that one already settled as an error: its
        // bubble is the closing word, not a stop the user never made.
        if (event.stopped === true && get().status !== "error") {
          pushDisplay(makeMsg("step", i18n.t("chat.runStopped")));
        }
        // After the flush above, the newest assistant message — if any — is the
        // prose this very run streamed, so it is the only dedup target.
        const lastProse = [...get().messages]
          .reverse()
          .find((m) => m.role === "assistant")?.content;
        const closing = closingSummary(sawAssistantText, lastProse, event.summary);
        if (closing) pushDisplay(makeMsg("assistant", closing));
        recallQueue();
        set({ runStopped: event.stopped === true });
        settleRun("idle");
        // The stop was a redirect, not just a halt: the queued text runs as the
        // next task now that the old run has fully unwound.
        const pending = get().pendingSend;
        if (pending !== null) {
          // Clear BEFORE sendTask — the guard above would otherwise bail. The
          // parked command sits this one out: sendTask only reaches `running`
          // after an await, so a drain here would land in the gap and fold a
          // conversation whose next run is already committed.
          set({ pendingSend: null });
          void sendTask(pending);
        } else {
          drainDeferred();
        }
        break;
      }
    }
  };

  /**
   * Everything the worker sends, before `handleEvent` sees it.
   *
   * The panel is per-window, so a run's events now reach every open panel. Two
   * jobs here, and both have to happen outside the switch:
   *
   * 1. **Drop what is not ours.** A stamped event belongs to one conversation;
   *    a panel showing another one ignores it. Unstamped means a reply to this
   *    panel's own command, which was never broadcast and cannot be misrouted.
   *    Filtering out here also keeps a foreign event away from the
   *    dispatch-and-forget close handshake at the top of `handleEvent`.
   * 2. **Adopt the stream.** A panel that did not dispatch the run still renders
   *    it, so it has to say so: while `status` reads idle the conversation-index
   *    watch keeps refetching the transcript, and storage holds none of the live
   *    rows this panel is now drawing — the two would fight and the transcript
   *    would double up.
   */
  const handleMessage = (msg: PanelMessage) => {
    const { conversationId, ...rest } = msg;
    const event = rest as Event;
    if (conversationId !== undefined && conversationId !== get().activeId) return;
    const live = get().board.running;
    if (
      conversationId !== undefined &&
      live?.conversationId === conversationId &&
      live.owner === "panel" &&
      get().status !== "running"
    ) {
      // The board, not the event type: it is the authoritative "a run is live
      // here", so a stamped straggler that means the opposite — a compaction
      // receipt, the artifact a finished run emits last — can never revive a
      // settled panel. It lags the first events by a tick, but so does the
      // refetch this guards against: both read the same board.
      //
      // Panel-owned only. A schedule or bridge run sends this panel nothing (it
      // follows along through the transcript refetch), so adopting one would
      // switch off its only sync path and wait forever for a `done` that is not
      // coming — and a bridge run adopted as our own would hide the band naming
      // the client that actually holds it.
      //
      // The numbers reset with it. They belong to a run, not to a panel, and
      // this panel's are the LAST run's: left standing they put a finished
      // run's 40k on a run six seconds old, and a gauge that could already read
      // red — which is the whole bug this fan-out exists to fix, surviving it.
      sawAssistantText = false;
      set({
        status: "running",
        runStartedAt: live.startedAt,
        runEndedAt: null,
        runStopped: false,
        usage: { input: 0, output: 0 },
        // Back to the stored fallback (`ConversationMeta.contextTokens`) until this run
        // reports its own — the same thing a reopened panel shows.
        contextTokens: 0,
        // Nothing of ours is in flight: this run's rows and cards are arriving.
        pendingStepId: null,
        planMsgId: null,
        planApproved: false,
        replanning: false,
      });
    }
    handleEvent(event);
  };

  /** Send if the port lives, swallow if it died — onDisconnect does the cleanup. */
  const post = (cmd: Command) => {
    try {
      port?.postMessage(cmd);
    } catch {
      // Port already gone.
    }
  };

  const attach = (): chrome.runtime.Port => {
    if (port) return port;
    intentionalDisconnect = false;
    const p = chrome.runtime.connect({ name: PORT_NAME });
    port = p;
    p.onMessage.addListener(handleMessage);
    p.onDisconnect.addListener(() => {
      port = null;
      // The worker died with its state — nothing can be in the browser now; the
      // next connect re-asks and gets the fresh answer.
      set({ bridgeActive: null });
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (intentionalDisconnect) {
        intentionalDisconnect = false;
        return;
      }
      // The worker dropped us (dev hot-reload, update, crash) — never silent.
      // Written by the panel that DISPATCHED the run, not by every panel that
      // was watching it: this one persists, and one worker death across three
      // open windows would otherwise leave three copies of the same line in the
      // transcript. The others settle quietly; the run is equally dead for them.
      if (get().status === "running" && get().lastRun) {
        pushMsg(makeMsg("error", i18n.t("chat.portLost")));
      }
      // A compaction in flight died with the worker, and no `compacted` event is
      // ever coming — without this the shimmer row keeps promising a fold that
      // nobody is doing. The worker owns the write, so the summary may have
      // landed anyway: refetch rather than assume either way.
      if (get().compactingSince !== null) {
        set({ compactingSince: null });
        resumeAfterCompact = null;
        const activeId = get().activeId;
        const note = makeMsg(
          "step",
          i18n.t("commands.compact.failed", { message: i18n.t("chat.reloaded") }),
        );
        // The note goes on AFTER the refetch, never before: it is display-only,
        // and a storage read landing on top of it would wipe the one line
        // saying why the row it replaced went away.
        if (activeId) {
          void getMessages(activeId).then((messages) => {
            if (get().activeId !== activeId) return;
            set({ messages: capMessages(messages) });
            pushDisplay(note);
          });
        } else {
          pushDisplay(note);
        }
      }
      recallQueue();
      // A stop redirect must survive a mid-handoff port drop — back to the composer.
      returnPending();
      settleRun("idle");
    });
    pingTimer ??= setInterval(() => post({ type: "ping" }), 25_000);
    // Ask on connect: the broadcast may have happened while the panel was
    // closed, and a stale state must never read as "the browser is idle".
    post({ type: "query_run" });
    // Name our window, so the worker's "is the user watching?" test can tell an
    // open panel in the focused window from one sitting behind another window.
    // A beat later than the connect — there is no synchronous way to ask — and
    // the worker treats a port that has not said hello yet as watching, so the
    // gap costs at most a suppressed notification, never a duplicate one.
    void chrome.windows.getCurrent().then(
      (w) => {
        if (w.id !== undefined) post({ type: "hello", windowId: w.id });
      },
      () => {
        // No window id — the worker keeps its "assume watching" default.
      },
    );
    return p;
  };

  /**
   * Point the panel at a thread. Three callers reach this — the user opening
   * one, the user starting a fresh one, and another window doing either — and
   * they must land identically, or two panels on the same conversation would
   * hold different state for it.
   *
   * `keepComposer` is the whole difference between a switch the user made and
   * one made for them: see `followActive`. Everything else a switch clears is
   * `resetRun`'s list.
   */
  const showConversation = (id: string | null, keepComposer = false) => {
    const { draft, pastedTexts, collapseDisabled } = get();
    set({
      ...resetRun(),
      ...(keepComposer ? { draft, pastedTexts, collapseDisabled } : {}),
      messages: [],
      activeId: id,
    });
    // A fresh chat has nothing to ask about, and asking anyway would be worse
    // than useless: with no id the worker falls back to the shared slot, which
    // the `setActiveConversation(null)` behind this has not necessarily cleared
    // yet — so the answer could arm a plan card for the thread just left.
    if (id === null) return;
    // Named, not left to the slot: a parked plan gate and the driven-tab chip
    // re-arm only on a fresh query, so without this, switching back to a parked
    // conversation shows "waiting for your approval" with the card gone — and
    // typed text would queue behind a run that cannot move. The id rides along
    // because with a panel open in every window, the slot can be pointed
    // somewhere else between the write behind this and the worker reading it.
    post({ type: "query_run", conversationId: id });
    void getMessages(id).then((messages) => {
      // A switch that raced this read wins — never paint a stale transcript.
      if (get().activeId === id) set({ messages });
    });
  };

  return {
    messages: [],
    conversations: [],
    activeId: null,
    status: "idle",
    streamingText: "",
    reasoningText: "",
    reasoningStartedAt: null,
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    runStopped: false,
    replanning: false,
    lastRun: null,
    runMode: runModePref.fallback,
    pendingStepId: null,
    planMsgId: null,
    planApproval: null,
    planApproved: false,
    recording: false,
    queued: [],
    pendingSend: null,
    draft: "",
    pastedTexts: [],
    collapseDisabled: false,
    drivingTab: null,
    bridgeActive: null,
    board: { queue: [] },
    queuedRun: null,
    compactingSince: null,
    deferred: null,
    draftEngine: null,
    contextTokens: 0,

    connect: () => {
      if (port) return;
      void runModePref.get().then((runMode) => {
        if (!runModeTouched) set({ runMode });
      });
      void listConversations().then((conversations) => set({ conversations }));
      unwatchConversations ??= watchConversations((conversations) => {
        set({ conversations });
        // A panel WATCHING a run rather than streaming it — reopened onto one,
        // or a second window on the same thread — gets no port events, so its
        // transcript would sit frozen for the length of the run. Every append
        // re-heads the index, so this watch is already the signal: pull what
        // the worker just wrote. Never while we own the stream — storage holds
        // no live rows, and adopting it would wipe the one in flight.
        const s = get();
        const id = s.activeId;
        if (s.status === "running" || id === null) return;
        if (s.board.running?.conversationId !== id) return;
        void getMessages(id).then((messages) => {
          const now = get();
          if (now.activeId === id && now.status !== "running") {
            set({ messages: capMessages(messages) });
          }
        });
      });
      void runBoardItem.get().then((board) => {
        set({ board });
        // Mounting into a run already in flight: the live band's clock would
        // otherwise start at panel-open and call the run younger than it is.
        const running =
          get().activeId !== null && board.running?.conversationId === get().activeId
            ? board.running
            : undefined;
        if (running) set({ runStartedAt: running.startedAt });
      });
      // Chrome draws one panel per window and they share the open-conversation
      // slot, so a thread opened anywhere is the thread every window is on.
      unwatchActive ??= watchActiveConversation((id) => get().followActive(id));
      unwatchBoard ??= runBoardItem.watch((board) => {
        const prev = get().board;
        set({ board });
        // A worker restart resets the board to empty — drop the queued chip
        // the dead queue can never fulfill.
        if (!board.running && board.queue.length === 0 && get().queuedRun) {
          set({ queuedRun: null });
        }
        // The frozen reopened panel: this conversation's run moved (started,
        // retargeted, finished) — pull the transcript the worker has been
        // writing so completion lands in the open panel. A question landing on
        // this conversation moves it the same way (running → pendingQuestion).
        const activeId = get().activeId;
        if (!activeId) return;
        const wasHere = prev.running?.conversationId === activeId;
        const isHere =
          board.running?.conversationId === activeId ||
          board.pendingQuestion?.conversationId === activeId;
        if (!isHere && !wasHere) return;
        // The live band's clock reads runStartedAt; a panel that reconnects
        // into a run already in flight would otherwise start it at panel-open
        // and call the run younger than it is. Anchor it to the run's real
        // start. Status stays the stream's — the board fallback in RunStatus
        // covers the close/has-none cases already.
        const running = board.running?.conversationId === activeId ? board.running : undefined;
        if (running) set({ runStartedAt: running.startedAt });
        // A run this panel only watches (reopened onto its own background run)
        // ends here, not on a `done` event — this is that run's settle point.
        drainDeferred();
        void getMessages(activeId).then((messages) => {
          // Never over the stream we own — the same rule the index watch above
          // keeps. Storage holds no live rows, so a mid-run board write (a tab
          // switch, the plan gate parking, the recorder arming) would replace
          // the tool row still spinning with a transcript that has never heard
          // of it. Safe at the end: `done` settles this panel to idle before
          // start-run's finally releases the slot and writes the board, so the
          // settle refetch this watch exists for still lands.
          if (get().activeId === activeId && get().status !== "running") set({ messages });
        });
      });
      void getActiveId().then(async (activeId) => {
        set({ activeId, messages: activeId ? await getMessages(activeId) : [] });
      });
      attach();
    },

    disconnect: () => {
      unwatchConversations?.();
      unwatchConversations = null;
      unwatchBoard?.();
      unwatchBoard = null;
      unwatchActive?.();
      unwatchActive = null;
      if (!port) return;
      intentionalDisconnect = true;
      port.disconnect();
      port = null;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    },

    sendTask,

    // A tool-less step row is the note: quiet, neutral, and gone on reopen.
    note: (content) => pushDisplay(makeMsg("step", content)),

    compact: (opts) => {
      if (get().compactingSince !== null) return;
      // Mid-run the wire conversation is the run's, not the transcript's — the
      // loop folds its own turns when it needs to (see compactRunMessages), and
      // a transcript summary landing under a live run would summarize a story
      // still being written. So it waits rather than refusing: "come back later"
      // makes the user remember and retype the one command they already typed.
      // Both callers park here — /compact routes through runSlash, but the
      // context-error CTA can be clicked long after a fresh run has started.
      if (runsHere(get())) {
        get().deferCommand("compact", () => get().compact(opts));
        return;
      }
      // No progress note: `compactingSince` draws a live shimmer row at the tail,
      // the same way a running step does, and the summary card replaces it
      // in place when the fold lands.
      set({ compactingSince: Date.now() });
      // Arm the resume against the task as it stands now: on success it fires
      // only if this is still the newest thing said — anything fresher (typed
      // while the summarizer ran, or a conversation switch, whose ids differ)
      // means the user has moved on.
      resumeAfterCompact = opts?.resume
        ? (get().messages.findLast((m) => m.role === "user")?.id ?? null)
        : null;
      // Which transcript to fold is named, not left to the shared slot: with a
      // panel open in every window that slot is whatever the last one opened,
      // and the wrong conversation would get summarized.
      const target = get().activeId;
      if (target === null) {
        // A thread with no first message yet has nothing to fold — the same
        // answer the worker gave when it resolved this from the slot itself.
        set({ compactingSince: null });
        pushDisplay(makeMsg("step", i18n.t("commands.compact.nothing")));
        return;
      }
      post({ type: "compact", conversationId: target });
    },

    cancelCompact: () => {
      const target = get().activeId;
      if (get().compactingSince === null || target === null) return;
      // Asked, not assumed: the worker answers with the quiet note that takes
      // the live row down, exactly as it does for a fold that finished. A local
      // settle here would race the summary — an abort that lost by a
      // millisecond would leave a summary in storage no panel went to fetch.
      post({ type: "cancel_compact", conversationId: target });
      // The resume the context-error CTA armed dies with the fold it was
      // waiting on — retrying into the same full window helps no one.
      resumeAfterCompact = null;
    },

    // One slot: a command parked twice is still one thing waiting, and the
    // second ask is the same ask.
    deferCommand: (name, run) => set({ deferred: { name, run } }),

    cancelDeferred: () => set({ deferred: null }),

    cancelQueuedRun: () => {
      const queued = get().queuedRun;
      if (!queued) return;
      post({ type: "cancel_queued", id: queued.id });
      // Optimistic settle — if the run raced ahead and started, its events
      // land next and the store recovers through them.
      settleRun("idle");
    },

    // The run board's per-row cancel — the worker validates it is a panel entry.
    cancelQueuedById: (id) => post({ type: "cancel_queued", id }),

    queueMessage: (text) => {
      const item = { id: crypto.randomUUID(), text };
      set({ queued: [...get().queued, item] });
      // Port gone mid-run: onDisconnect recalls the queue to the composer.
      post({ type: "inject", ...item });
    },

    unqueueMessage: (id) => {
      set({ queued: get().queued.filter((q) => q.id !== id) });
      post({ type: "unqueue", id });
    },

    recallQueued: () => {
      const queued = get().queued;
      const last = queued[queued.length - 1];
      if (!last) return;
      set({ queued: queued.slice(0, -1), draft: last.text, collapseDisabled: false });
      post({ type: "unqueue", id: last.id });
    },

    // The single user-edit writer (ChatInput routes every edit here): a collapse
    // whose token left the text drops its content — and, per draft, teaches the
    // input to paste inline: the fold is only ever a surprise once. Store-side
    // draft writers re-arm it — a recalled text is a fresh draft.
    setEngine: (patch, thisChatOnly) => {
      const { providers, activeId: storedId, update, activate } = useProvidersStore.getState();
      const inForce = engineProvider(providers, storedId, pinOf(get()));
      // Naming a provider adopts what THAT provider is set to run; refining a
      // model or effort keeps the rest of the pick in force. Either way the
      // result is a whole pick, never a half-applied one.
      const target = patch.providerId ? providers.find((p) => p.id === patch.providerId) : inForce;
      if (!target) return;
      const next: ConversationEngine = engineOf(target);
      if ("model" in patch) {
        if (patch.model) next.model = patch.model;
        else delete next.model;
      }
      if ("effort" in patch) {
        if (patch.effort) next.effort = patch.effort;
        else delete next.effort;
      }

      const activeId = get().activeId;
      if (activeId) void recordEngine(activeId, next);
      else set({ draftEngine: next });

      // The stored default follows your last deliberate pick — that is what a
      // new conversation starts on. ⌥ is the opt-out, and the only reason this
      // is a choice at all: retuning one old thread should not re-point every
      // thread you open tomorrow.
      if (thisChatOnly) return;
      void update(next.providerId, { model: next.model, reasoningEffort: next.effort });
      if (next.providerId !== storedId) void activate(next.providerId);
    },

    setDraft: (text) =>
      set((st) => {
        const kept = st.pastedTexts.filter((p) => text.includes(p.token));
        const dropped = kept.length < st.pastedTexts.length;
        return { draft: text, pastedTexts: kept, collapseDisabled: dropped || st.collapseDisabled };
      }),
    addPastedText: (entry) => set((st) => ({ pastedTexts: [...st.pastedTexts, entry] })),
    clearPastedTexts: () => set({ pastedTexts: [], collapseDisabled: false }),
    // Stored, not just held: the panel closes itself on every background
    // dispatch, and a mode that reset on each reopen made "in background" a
    // choice you had to re-make all afternoon.
    setRunMode: (target) => {
      runModeTouched = true;
      set({ runMode: target });
      void runModePref.set(target);
    },

    retry: () => {
      const target = retryTargetFrom(get().messages);
      const conversationId = get().activeId;
      if (!target || get().status === "running" || conversationId === null) return;
      // No duplicate user row — the failed attempt sits right above.
      let p: chrome.runtime.Port;
      try {
        p = attach();
      } catch {
        pushMsg(makeMsg("error", i18n.t("chat.reloaded")));
        return;
      }
      // Same as sendTask: the retry goes back through the plan gate, and the
      // panel leaves with the approval.
      startRun(p, conversationId, target.task, target.images);
    },

    stop: () => {
      // A queued message turns the halt into a redirect: the queue is sent as the
      // next task once the current run has fully unwound (its done event). A second
      // stop during the unwind must preserve the pending text, not wipe it.
      const pending =
        get().queued.length > 0
          ? get()
              .queued.map((x) => x.text)
              .join("\n")
          : get().pendingSend;
      post({ type: "stop" });
      // Deliberately NOT settleRun: the loop's done event arrives as the worker
      // unwinds and flushes any partial stream into the transcript first.
      set((st) => ({
        messages: settleLive(st.messages),
        status: "idle",
        runEndedAt: Date.now(),
        pendingStepId: null,
        planApproval: null,
        queued: [],
        pendingSend: pending,
      }));
    },

    approvePlan: () => {
      if (!get().planApproval) return;
      post({ type: "plan_approval", approved: true });
      // Approval is the handover: the gate is behind the run, so the band's
      // walk-away button unlocks (and a dispatched background run auto-closes).
      set({ planApproval: null, planApproved: true });
      // Approval is the handover: from here the run is unattended, so a
      // background one this panel dispatched takes the panel with it and gets
      // out of the way. The close waits for the next event — proof the approval
      // landed. A reject ends the run and a revision parks it again, so neither
      // closes; and a panel the user opened by hand to answer a parked run
      // (lastRun is another session's) stays, because closing a window someone
      // just opened reads as a crash, not as tact.
      const dispatched = get().lastRun;
      if (dispatched?.background) schedulePanelClose();
    },

    rejectPlan: () => {
      if (!get().planApproval) return;
      post({ type: "plan_approval", approved: false });
      set({ planApproval: null });
    },

    revisePlan: (feedback) => {
      if (!get().planApproval) return;
      const note = feedback.trim();
      if (!note) return;
      post({ type: "plan_approval", approved: false, feedback: note });
      // The gate re-arms: the REVISED plan must earn the walk-away back. And
      // the band switches to "Revising the plan…" until the new card arrives,
      // so the redraft minutes never read as a swallowed note.
      set({ planApproval: null, planApproved: false, replanning: true });
      // The note is a user message like any other: the transcript shows what
      // the plan was sent back with, and the next run reads it as history.
      // Persisted here, drawn from the plan_answered echo — every panel showing
      // the thread had the card, so every one of them draws the answer, and
      // only the panel that sent it writes.
      const id = get().activeId;
      if (id) void appendMessageTo(id, makeMsg("user", note));
    },

    newConversation: () => {
      void setActiveConversation(null);
      showConversation(null);
    },

    followActive: (id) => {
      // Someone else opened this — a click in another window, a notification, a
      // pill on the page. Same switch as opening it here, minus the slot write
      // that caused it, and minus the composer: losing half a typed message
      // because another window changed the subject is worse than a draft that
      // outlives the thread it was started on. `sending` holds it off entirely
      // (see the flag) — that window is where a moved slot does real damage.
      if (sending || get().activeId === id) return;
      showConversation(id, true);
    },

    openConversation: (id) => {
      if (get().activeId === id) return;
      void setActiveConversation(id);
      showConversation(id);
    },

    // No optimistic set: the index watch already feeds `conversations`, and one
    // write's echo repaints both the header and the row that raised it.
    renameConversation: (id, title) => {
      void renameConversation(id, title);
    },

    removeConversation: (id) => {
      void deleteConversation(id);
      set((st) => ({
        conversations: st.conversations.filter((c) => c.id !== id),
        // Deleting the open one drops you into a fresh transcript, not a void.
        ...(st.activeId === id ? { ...resetRun(), messages: [], activeId: null } : {}),
      }));
    },
  };
});
