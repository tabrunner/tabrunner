import { createWriteQueue, defineItem } from "@/lib/storage";
import { truncateTo } from "@/lib/format";
import { cancelQueued, listQueue } from "@/modules/agent/run-queue";
import { deleteSchedule, disarmSchedule, schedulesForConversation } from "@/modules/schedule";
import { removeRecordingsFor } from "@/modules/walkthrough";
import type { Message } from "./types";
import type { ConversationEngine, ReasoningEffort } from "@/modules/providers/types";

/** A tab the conversation's runs drove — lets the next run spot a tab change. */
export interface LastTab {
  /** The comparison key: tab ids die with their tabs, urls survive them. */
  url: string;
  title: string;
  /** Opportunistic hint only — may point at a long-closed tab. */
  tabId?: number;
  /** The thread's tab group, when the tab ended its run in one a run labeled —
   *  reused only while the group is still alive (strips outlive their tabs). */
  groupId?: number;
}

/** A run's closing numbers — how long it went and what it cost. */
export interface RunSummary {
  startedAt: number;
  endedAt: number;
  input: number;
  output: number;
  /** The resolved engine — what answered, so the settled band can say so.
   *  Absent on summaries from before the engine event existed. */
  model?: string;
  effort?: ReasoningEffort;
  /** The run's dollar estimate at list price, summed across its calls. Absent
   *  when nothing priced — a model outside the pricing table, or a summary
   *  from before costs were tracked. Unknown is not zero. */
  cost?: number;
  /** False when the run ended on an error — the band names it, never "done". */
  ok?: boolean;
  /** True when the user halted it — the band says "Stopped", not "Done". */
  stopped?: boolean;
}

/** List-view metadata — the list reads only this, never the message arrays. */
export interface ConversationMeta {
  id: string;
  /** First user message, truncated. Empty until one lands — the UI labels those. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * How many tasks the user sent — one per run, which is the unit a history row
   * is scanned for. Counting stored entries instead pegged every row at
   * MAX_MESSAGES: one run writes dozens of step and reasoning rows, so any real
   * conversation reported the cap and every row read alike.
   *
   * Optional because rows last written before the count meant tasks carry no
   * value — they show their time alone until their next message fills it in.
   * Backfilling would mean reading fifty transcripts at panel open for a number
   * that costs nothing to wait for.
   */
  taskCount?: number;
  /** Tabs this conversation's runs drove, most recently worked first. */
  tabs?: LastTab[];
  /**
   * What the thread's strip held when the last run settled — every tab in the
   * group, not just the driven one. It is how a run re-finds the strip after a
   * restart recycles every id: the driven tab is often the one the user closes
   * when the task ends, leaving the strip standing on tabs `group_tab` filed —
   * pages `tabs` above never records. Snapshot, not history: a run that had no
   * strip leaves it alone rather than erasing it.
   */
  stripUrls?: string[];
  /**
   * The last run's closing numbers, stamped when it ended. The status band a
   * reopened panel shows above the composer reads this — the run's own panel
   * state died with the close. Retired by the next user message.
   */
  lastRun?: RunSummary;
  /**
   * How full the model's context was on this thread's last measured turn — the
   * provider's own input count, which only it can tell us.
   *
   * It sits on the CONVERSATION rather than inside `lastRun`, where it started,
   * because it is not a fact about a run: a run's duration and cost are over
   * when it ends, but the context it left behind is still there, and it is
   * still there after you type the next message. `lastRun` is retired by that
   * message (the band above the composer is about the run that just finished);
   * this is not, or the gauge would blank on every send and come back a minute
   * later with the same number it already had.
   *
   * Absent until a turn reports usage — the gauge shows nothing rather than
   * guessing (see ContextGauge), and some OpenAI-compatible endpoints never
   * report any.
   */
  contextTokens?: number;
  /**
   * The thread's lifetime spend — every run's cost summed as its summary
   * lands. A running total rather than a sum over transcripts: usage lives on
   * the index row, never on messages, so there is nothing to re-derive it
   * from, and the one write that already stamps the summary is the one place
   * that can add to it for free. Absent until a first priced run.
   */
  spentTotal?: number;
  /**
   * What drove this conversation, when it wasn't the user's own panel — an
   * external client's name ("Claude Code"), or the standing label a schedule's
   * thread carries. History shows it: a transcript the user never started, with
   * nothing saying where it came from, reads as a stranger in their own browser.
   */
  agent?: string;
  /**
   * What this conversation runs on — pinned at its first run, and rewritten
   * whenever the picker names something else. Absent means never pinned: it
   * falls back to the stored pick, which is also how every conversation
   * written before this field behaves.
   */
  engine?: ConversationEngine;
  /**
   * The plan steps the user last approved here — the plan gate's memory across
   * runs. A later run that re-sends the same arc (cursor advanced) doesn't
   * re-ask what was already said yes to; only the model's own deviation flag
   * reopens the question. Cleared when a plan comes back for revision, so the
   * revised list asks fresh instead of riding the old yes.
   */
  approvedPlan?: string[];
  /**
   * The thread belongs to a scheduled task rather than an MCP client. Both wear
   * a label in `agent`, but only one of them arrived over MCP — and the history
   * row says which in its accessible name, so the two must stay tellable apart.
   */
  scheduled?: boolean;
}

// ponytail: fixed caps keep chrome.storage.local under quota — unbounded
// transcripts eventually fail writes silently. Ceilings: a very long run loses
// its oldest messages, and the 51st conversation evicts the least recently
// touched one. Upgrade path is IndexedDB if transcripts must be permanent.
export const MAX_MESSAGES = 100;
const MAX_CONVERSATIONS = 50;
const TITLE_LENGTH = 60;

/** Index of every stored conversation, most recently touched first. */
const indexItem = defineItem<ConversationMeta[]>("conversations", []);
/** Which conversation the panel is showing. null = a fresh one, not created yet. */
const activeItem = defineItem<string | null>("active-conversation", null);
/** One key per conversation — appending rewrites one transcript, not all of them. */
const messagesItem = (id: string) => defineItem<Message[]>(`conversation:${id}`, []);

export function listConversations(): Promise<ConversationMeta[]> {
  return indexItem.get();
}

export function watchConversations(cb: (list: ConversationMeta[]) => void): () => void {
  return indexItem.watch(cb);
}

export function getActiveId(): Promise<string | null> {
  return activeItem.get();
}

/**
 * Follow the open conversation. Chrome draws one side panel per window and
 * they share this slot, so a thread opened in one window is the thread every
 * window is on — otherwise a notification click re-points the slot and only a
 * panel that was CLOSED at the time ever notices (`sidePanel.open()` is a no-op
 * on one already up).
 */
export function watchActiveConversation(cb: (id: string | null) => void): () => void {
  return activeItem.watch(cb);
}

export function getMessages(id: string): Promise<Message[]> {
  return messagesItem(id).get();
}

/** Opens a conversation. null starts a fresh one, created on its first message. */
export function setActiveConversation(id: string | null): Promise<void> {
  return activeItem.set(id);
}

/**
 * A conversation spans the tabs its runs drove — one run per message, and the
 * user moves between messages. The list is the run-start note's source, so it
 * stays short: deduped by url, newest work first, capped.
 */
const MAX_CONVERSATION_TABS = 5;
/**
 * The strip's membership is a wider net than the driven-tab list and is never
 * shown to the model, so it gets its own ceiling — big enough for a real
 * working set, small enough that fifty conversations of them stay cheap.
 */
const MAX_STRIP_URLS = 10;

/** Everything a run needs to place itself in the thread's pages. */
export interface ThreadTabs {
  /** The tabs the conversation's runs drove, most recently worked first. */
  tabs: LastTab[];
  /** What the thread's strip held at the last settle — the content-scan's key. */
  stripUrls: string[];
}

export async function getThreadTabsFor(id: string): Promise<ThreadTabs> {
  const row = (await indexItem.get()).find((c) => c.id === id);
  return { tabs: row?.tabs ?? [], stripUrls: row?.stripUrls ?? [] };
}

/**
 * Rewrites one conversation's index row inside the write chain — the shape
 * every meta-field writer here shares. Returning undefined leaves the row
 * alone (no rewrite at all), which is how a patch expresses "not mine to
 * change". A row that isn't there stays gone: no writer here resurrects a
 * deleted conversation's record — append is the only path allowed to.
 */
async function patchConversation(
  id: string,
  patch: (c: ConversationMeta) => ConversationMeta | undefined,
): Promise<void> {
  return serialized(async () => {
    const list = await indexItem.get();
    const row = list.find((c) => c.id === id);
    if (!row) return;
    const next = patch(row);
    if (!next) return;
    await indexItem.set(list.map((c) => (c.id === id ? next : c)));
  });
}

/**
 * Records where a run drove — re-driving a tab moves it back to the front —
 * and, when the run had a strip, what that strip holds now. Serialized like
 * every other index write: this lands in the same tick as the run's closing
 * append and summary, and an unserialized read-modify-write here loses the
 * whole tabs list to theirs — which is what made every follow-up run forget
 * the thread's strip and mint a second one. Both fields ride one patch for
 * the same reason.
 *
 * `stripUrls` undefined means "this run had no strip" — the thread's last known
 * one stands. A run that only read a page must not erase the memory of it.
 */
export function recordDrivenTabFor(id: string, tab: LastTab, stripUrls?: string[]): Promise<void> {
  return patchConversation(id, (c) => ({
    ...c,
    tabs: [tab, ...(c.tabs ?? []).filter((t) => t.url !== tab.url)].slice(
      0,
      MAX_CONVERSATION_TABS,
    ),
    ...(stripUrls ? { stripUrls: stripUrls.slice(0, MAX_STRIP_URLS) } : {}),
  }));
}

/**
 * Stamps the conversation's index row with its just-ended run's summary, and
 * with the context the run leaves behind — one write, because they land at the
 * same moment and a second pass would just be a second storage notification.
 * Serialized with the transcript writes so the record never lands ahead of the
 * run's own closing messages. A conversation deleted mid-run stays deleted.
 */
export function recordRunSummary(
  id: string,
  run: RunSummary,
  contextTokens?: number,
): Promise<void> {
  return patchConversation(id, (c) => ({
    ...c,
    lastRun: run,
    ...(contextTokens ? { contextTokens } : {}),
    // The lifetime total grows only when this run priced — an unpriced run
    // adds nothing rather than resetting the total.
    ...(run.cost !== undefined ? { spentTotal: (c.spentTotal ?? 0) + run.cost } : {}),
  }));
}

/**
 * A fold shrank what this thread replays, so the stored occupancy has to shrink
 * with it. The reading is the last turn's input — system prompt, tools, page
 * snapshot AND the replayed history — and only the last of those moved, which
 * is exactly the arithmetic the live panel already does on its own copy.
 *
 * Without it the number survives the fold: the receipt says 18.4k → 1.2k and
 * the gauge right above it still reads 18.4k, in every window that was not the
 * one that asked, and in that one too as soon as it is reopened.
 */
export function noteContextFreed(id: string, freed: number): Promise<void> {
  if (freed <= 0) return Promise.resolve();
  return patchConversation(id, (c) => {
    // Never measured means nothing to correct — the next run measures fresh.
    if (!c.contextTokens) return undefined;
    return { ...c, contextTokens: Math.max(0, c.contextTokens - freed) };
  });
}

/** One conversation's index row — how a run reads the engine it is pinned to. */
export async function getConversationMeta(id: string): Promise<ConversationMeta | undefined> {
  return (await indexItem.get()).find((c) => c.id === id);
}

/**
 * Pins what this conversation runs on. Written by the picker, and by a run that
 * found no pin (or found one naming a provider that is gone) — so the chip and
 * the run can never disagree for longer than one run.
 */
export function recordEngine(id: string, engine: ConversationEngine): Promise<void> {
  return patchConversation(id, (c) => ({ ...c, engine }));
}

/**
 * Sets (or clears) the conversation's standing plan approval. The loop calls
 * this at every gate transition — a plan accepted or approved keeps its steps,
 * one sent back for revision drops them — so the next run's gate knows what
 * this conversation already said yes to.
 */
export function recordApprovedPlan(id: string, steps: string[] | null): Promise<void> {
  return patchConversation(id, (c) => {
    const next = { ...c };
    if (steps) next.approvedPlan = steps;
    else delete next.approvedPlan;
    return next;
  });
}

/**
 * Creates the thread an external MCP client is about to drive, stamped with
 * which client it was. Called once when the bridge opens a thread; the goal or
 * task it writes next becomes the title, exactly as a panel task does.
 */
export async function openAgentConversation(id: string, agent: string): Promise<void> {
  await serialized(() => ensureConversation(id, agent));
}

/**
 * Creates (or re-creates) the thread a schedule's fires append to. Called before
 * every fire, not once: the transcript can fall off the conversation cap between
 * runs, and a schedule whose thread is gone must still have somewhere to write.
 *
 * Returns whether the thread was already there. A scheduled run is told the
 * conversation above it is its own earlier fires, so the caller has to know when
 * that stopped being true — an empty history reads as "I have never done this".
 * (Deletion is not one of these cases any more: deleting the thread cancels the
 * schedule, so the only way back here is eviction.)
 */
export function openScheduledConversation(
  id: string,
  label: string,
  engine?: ConversationEngine,
): Promise<boolean> {
  return serialized(async () => {
    const existed = (await indexItem.get()).some((c) => c.id === id);
    await ensureConversation(id, label, true, engine);
    return existed;
  });
}

/** First line of the task, trimmed to fit a list row. */
export function conversationTitle(text: string): string {
  const line = (text.trim().split("\n", 1)[0] ?? "").trim();
  return truncateTo(line, TITLE_LENGTH);
}

/**
 * Whether the derived title is only a FRAGMENT of the task — the first line was
 * clipped, or there were further lines it never saw. This is the whole test for
 * "the heuristic did badly here": a one-line task that fits is its own best
 * title, while "hey\ngo book me a table" titles as "hey".
 */
export function isPartialTitle(text: string): boolean {
  return conversationTitle(text) !== text.trim();
}

/**
 * Renames a conversation. `updatedAt` deliberately stays put: renaming is not
 * activity, and re-heading the index would yank the row to the top of history
 * for a cosmetic edit. An empty title restores the derived one on the next
 * message (appendTo fills a blank title), which is what clearing the field means.
 */
export function renameConversation(id: string, title: string): Promise<void> {
  return patchConversation(id, (c) => ({ ...c, title: conversationTitle(title) }));
}

/**
 * Replaces a title the user has not touched. The auto-titler lands a run late,
 * long after a rename could have happened, and must never overwrite one — but a
 * title still equal to what the first message derived is provably untouched, so
 * the comparison IS the flag and no stored field is needed.
 */
export function retitleIfDerived(id: string, derived: string, title: string): Promise<void> {
  return patchConversation(id, (row) => {
    // A title still equal to what the first message derived is provably
    // untouched — the comparison is the flag, no stored field needed.
    if (row.title !== derived) return undefined;
    const next = conversationTitle(title);
    return next ? { ...row, title: next } : undefined;
  });
}

/**
 * Resolves the conversation's metadata, creating it if it doesn't exist — or
 * if the record was deleted mid-run and left the id dangling. Never touches the
 * active item: id-targeted writers (the bridge's MCP thread) use this without
 * disturbing the panel's open conversation.
 */
async function ensureConversation(
  id: string,
  agent?: string,
  scheduled?: boolean,
  engine?: ConversationEngine,
): Promise<ConversationMeta> {
  const list = await indexItem.get();
  const existing = list.find((c) => c.id === id);
  if (existing) return existing;

  const now = Date.now();
  const meta: ConversationMeta = {
    id,
    title: "",
    createdAt: now,
    updatedAt: now,
    taskCount: 0,
    ...(agent ? { agent } : {}),
    ...(scheduled ? { scheduled: true } : {}),
    ...(engine ? { engine } : {}),
  };
  const kept = [meta, ...list].slice(0, MAX_CONVERSATIONS);
  const evicted = list.slice(MAX_CONVERSATIONS - 1);
  // A conversation's walkthroughs are megabytes of blobs in another store —
  // orphaning them here would quietly own the disk with nothing left pointing
  // at them. Best-effort: eviction must not fail because a blob store did.
  await Promise.all(
    evicted.flatMap((c) => [
      messagesItem(c.id).remove(),
      removeRecordingsFor(c.id).catch(() => {}),
    ]),
  );
  await indexItem.set(kept);
  return meta;
}

/** Appends to a specific conversation and returns its id. */
export function appendMessageTo(id: string, msg: Message): Promise<string> {
  return serialized(() => appendTo(id, msg));
}

/**
 * The first message of the panel's fresh thread — mints the conversation
 * outright instead of resolving the shared active slot. Between "New
 * conversation" (slot → null) and this append, a pill or notification click
 * can re-point the slot at another thread, and a read here would file the
 * fresh opener under THAT one: the panel adopts the id but keeps rendering
 * the live stream, and the old transcript materializes at run end — the
 * "conversation switched itself" bug. The panel knows it is fresh; say so.
 */
export function appendMessageFresh(msg: Message): Promise<string> {
  return serialized(async () => {
    const id = crypto.randomUUID();
    await activeItem.set(id);
    return appendTo(id, msg);
  });
}

/**
 * Screenshots are captured for the model, not for scrollback: one run can take
 * a dozen and base64 in storage.local blows the quota outright. Attachments the
 * user sent stay — a transcript missing the image you pasted reads as if you
 * never sent it.
 *
 * ponytail: the ceiling is that a reopened conversation shows a screenshot
 * step's summary without its thumbnail. Upgrade path is IndexedDB blobs.
 */
function stripTransientImages(msg: Message): Message {
  if (msg.role === "user" || !msg.images) return msg;
  const stored = { ...msg };
  delete stored.images;
  return stored;
}

/**
 * Every stored write is read-modify-write, and the panel fires them from an
 * event stream: a run that streams prose and then lands a done summary starts
 * two appends in the same tick, both read the same array, and the second write
 * erases the first. Serializing them is what makes the transcript — and the
 * history the next run replays from it — complete.
 *
 * ponytail: one chain per JS context, not a cross-context lock. The ceiling is
 * that the worker's own append (the panel-closed breadcrumb) races the panel's;
 * it only happens as the panel dies, which is the moment it stops writing.
 */
const serialized = createWriteQueue();

/**
 * Resolves once every write issued so far has committed. A run's board entry must
 * clear only after its transcript is durably stored: the panel reloads the
 * transcript the moment the board moves, and a read that beats a pending append
 * wipes the run's closing messages (the error bubble, an injected line) off the
 * screen they were just painted on.
 */
export function flushConversationWrites(): Promise<void> {
  return serialized(async () => {});
}

async function appendTo(id: string, msg: Message): Promise<string> {
  const meta = await ensureConversation(id);
  const item = messagesItem(meta.id);
  const messages = [...(await item.get()), stripTransientImages(msg)].slice(-MAX_MESSAGES);
  await item.set(messages);

  const updated: ConversationMeta = {
    ...meta,
    title: meta.title || (msg.role === "user" ? conversationTitle(msg.content) : ""),
    updatedAt: msg.timestamp,
    taskCount: messages.filter((m) => m.role === "user").length,
  };
  // A fresh task retires the last run's summary — the band above the composer
  // keeps it only until the next message.
  if (msg.role === "user") delete updated.lastRun;
  // Re-heading the index is what keeps it sorted by recency.
  const list = await indexItem.get();
  await indexItem.set([updated, ...list.filter((c) => c.id !== meta.id)]);
  return meta.id;
}

/**
 * Rewrites one stored message in place. The plan card is state, not an entry:
 * appending every revision would bury the transcript in stale checklists.
 * Id-targeted — the writer replaces plan cards in whatever conversation the run
 * lives in.
 */
export function replaceMessageTo(id: string, msg: Message): Promise<void> {
  return serialized(() => replaceTo(id, msg));
}

async function replaceTo(id: string, msg: Message): Promise<void> {
  const item = messagesItem(id);
  const messages = await item.get();
  if (!messages.some((m) => m.id === msg.id)) return;
  await item.set(messages.map((m) => (m.id === msg.id ? stripTransientImages(msg) : m)));
}

export async function deleteConversation(id: string): Promise<void> {
  // Cancel its queued runs first — a waiting task's first write would
  // resurrect the transcript being deleted. No breadcrumb here, for the same
  // reason: writing one would recreate the ghost too.
  for (const q of listQueue()) {
    if (q.conversationId === id) cancelQueued(q.id);
  }
  // A schedule's thread is not incidental to it — it IS the memory the next fire
  // reads back ("what did I find last time?"). Leaving the rule armed over a
  // deleted transcript gives you an amnesiac agent doing unattended work at 3am,
  // and re-creating the row at that fire resurrects a conversation the user
  // deleted. Both are worse than ending it here; the panel's confirm says so
  // before this runs, and Settings → Schedules can pause instead.
  for (const s of await schedulesForConversation(id)) {
    await deleteSchedule(s.id);
    await disarmSchedule(s.id);
  }
  await messagesItem(id).remove();
  await removeRecordingsFor(id).catch(() => {});
  await indexItem.set((await indexItem.get()).filter((c) => c.id !== id));
  if ((await activeItem.get()) === id) await activeItem.set(null);
}
