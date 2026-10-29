import { describe, it, expect } from "vitest";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

import {
  appendMessageFresh,
  appendMessageTo,
  conversationTitle,
  deleteConversation,
  getActiveId,
  getThreadTabsFor,
  getMessages,
  isPartialTitle,
  listConversations,
  MAX_MESSAGES,
  openScheduledConversation,
  recordApprovedPlan,
  recordDrivenTabFor,
  recordEngine,
  renameConversation,
  replaceMessageTo,
  retitleIfDerived,
  setActiveConversation,
} from "../conversations";
import { listSchedules, saveSchedule } from "@/modules/schedule/store";
import type { Message } from "../types";

let seq = 0;
function msg(role: Message["role"], content: string): Message {
  return { id: `m${++seq}`, role, content, timestamp: 1_000 + seq };
}

/** The driven-tab half of the thread record — what most of these assert on. */
const threadTabs = async (id: string) => (await getThreadTabsFor(id)).tabs;

describe("conversationTitle", () => {
  it("takes the first line and truncates long tasks", () => {
    expect(conversationTitle("  go to hn\nand summarize  ")).toBe("go to hn");
    expect(conversationTitle("x".repeat(80))).toHaveLength(60);
  });
});

describe("isPartialTitle", () => {
  it("is false only when the first line IS the whole task", () => {
    expect(isPartialTitle("book a flight")).toBe(false);
    // A second line the title never saw.
    expect(isPartialTitle("hey\nbook a flight")).toBe(true);
    // A first line longer than the row fits.
    expect(isPartialTitle("x".repeat(80))).toBe(true);
  });
});

describe("renameConversation", () => {
  it("sets the title without disturbing recency", async () => {
    const id = await appendMessageFresh(msg("user", "first task"));
    const before = (await listConversations()).find((c) => c.id === id)!;

    await renameConversation(id, "  My Trip Planning  ");
    const after = (await listConversations()).find((c) => c.id === id)!;
    expect(after.title).toBe("My Trip Planning");
    // A rename is not activity — the row keeps its place in history.
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

describe("retitleIfDerived", () => {
  it("retitles an untouched title, never a renamed one", async () => {
    const id = await appendMessageFresh(msg("user", "hey\nbook a table"));
    const derived = conversationTitle("hey\nbook a table");

    await retitleIfDerived(id, derived, "Book a table at Rossi's");
    expect((await listConversations()).find((c) => c.id === id)!.title).toBe(
      "Book a table at Rossi's",
    );

    // A user rename after that must survive a late auto-title for the same
    // conversation — the derived-string comparison is the only guard.
    await renameConversation(id, "Dinner");
    await retitleIfDerived(id, derived, "Another title");
    expect((await listConversations()).find((c) => c.id === id)!.title).toBe("Dinner");
  });
});

describe("conversations", () => {
  it("creates on first append, titles from the user message, tracks recency", async () => {
    const first = await appendMessageFresh(msg("user", "book a flight to Lisbon"));
    await appendMessageTo(first, msg("step", "click"));
    await appendMessageTo(first, msg("assistant", "done"));

    expect(await getActiveId()).toBe(first);
    // One task, not three entries: the count is what the user sent, so a run's
    // steps and replies can't peg every history row at the transcript cap.
    expect(await listConversations()).toEqual([
      expect.objectContaining({ id: first, title: "book a flight to Lisbon", taskCount: 1 }),
    ]);

    // "New chat" — a fresh transcript, created by its own first message.
    const second = await appendMessageFresh(msg("user", "summarize this PR"));
    expect(second).not.toBe(first);

    const list = await listConversations();
    expect(list.map((c) => c.id)).toEqual([second, first]); // newest touched first
    expect(await getMessages(first)).toHaveLength(3); // the first transcript survives

    // Reopening an old conversation appends to it and re-heads the list.
    await appendMessageTo(first, msg("user", "and again"));
    expect((await listConversations()).map((c) => c.id)).toEqual([first, second]);
    expect((await listConversations())[0]?.title).toBe("book a flight to Lisbon"); // title is sticky
  });

  it("a fresh thread's opener never files under a re-pointed active slot", async () => {
    // The "conversation switched itself" regression: between "New conversation"
    // and the first message, a pill or notification click re-points the shared
    // active slot at the run's thread. Resolving that slot on append would
    // file the fresh opener under THAT thread — the panel adopts the id, keeps
    // rendering the live stream, and the old transcript materializes at run
    // end. The fresh append mints its own id instead of reading the slot.
    const old = await appendMessageFresh(msg("user", "the thread a run is working"));
    await setActiveConversation(old); // the click lands before the first keystroke

    const fresh = await appendMessageFresh(msg("user", "what the fresh thread asked"));

    expect(fresh).not.toBe(old);
    expect((await getMessages(old)).map((m) => m.content)).toEqual(["the thread a run is working"]);
    expect(await getActiveId()).toBe(fresh);
  });

  it("delete drops the transcript, its index entry, and the active pointer", async () => {
    const id = await appendMessageFresh(msg("user", "throwaway task"));

    await deleteConversation(id);

    expect(await getMessages(id)).toEqual([]);
    expect((await listConversations()).some((c) => c.id === id)).toBe(false);
    expect(await getActiveId()).toBeNull();
  });

  /**
   * The bug this closes: deleting a scheduled thread left the schedule armed
   * over a transcript that no longer existed, and the next fire re-created the
   * row by id — so a conversation the user deleted came back, empty, at 9am,
   * and the delete that looked like it had stopped the task hadn't.
   */
  it("takes the schedules that write into a thread down with it", async () => {
    const id = await appendMessageFresh(msg("user", "check the deploy"));
    await saveSchedule({
      id: "sched-1",
      task: "check the deploy",
      recurrence: { kind: "interval", everyMinutes: 20 },
      conversationId: id,
      nextFireAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });

    await deleteConversation(id);

    expect(await listSchedules()).toEqual([]);
  });

  it("leaves other threads' schedules alone", async () => {
    const mine = await appendMessageFresh(msg("user", "throwaway"));
    await saveSchedule({
      id: "sched-2",
      task: "someone else's morning report",
      recurrence: { kind: "daily", time: "09:00" },
      conversationId: "another-thread",
      nextFireAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });

    await deleteConversation(mine);

    expect((await listSchedules()).map((s) => s.id)).toEqual(["sched-2"]);
  });

  /**
   * A scheduled run is told the conversation above it is its own earlier fires.
   * Eviction is the one way that premise can break now, and the run has to hear
   * about it — an empty history otherwise reads as "I have never done this".
   */
  it("reports whether a schedule's thread was still there", async () => {
    const id = "sched-thread";
    expect(await openScheduledConversation(id, "Scheduled")).toBe(false);
    expect(await openScheduledConversation(id, "Scheduled")).toBe(true);
  });

  it("keeps every message when appends are fired in the same tick", async () => {
    // The regression: read-modify-write appends started together all read the
    // same array and the last write won, silently dropping the others — which
    // cost the next run the exchange it was asked to continue.
    const id = await appendMessageFresh(msg("user", "propose names"));
    await Promise.all([
      appendMessageTo(id, msg("assistant", "here is the list")),
      appendMessageTo(id, msg("user", "search them")),
    ]);

    expect((await getMessages(id)).map((m) => m.content)).toEqual([
      "propose names",
      "here is the list",
      "search them",
    ]);
  });

  it("re-creates a conversation whose record was deleted mid-run", async () => {
    const id = await appendMessageFresh(msg("user", "long run"));
    await deleteConversation(id);

    // A racing run's write re-creates the record under the same id.
    await appendMessageTo(id, msg("step", "clicked"));

    expect((await listConversations()).some((c) => c.id === id)).toBe(true);
    expect(await getMessages(id)).toHaveLength(1);
  });

  it("remembers the tabs a conversation's runs drove, newest first", async () => {
    const first = await appendMessageFresh(msg("user", "check gmail"));
    expect(await threadTabs(first)).toEqual([]); // no run yet

    await recordDrivenTabFor(first, { url: "https://mail.google.com/", title: "Inbox", tabId: 7 });
    await recordDrivenTabFor(first, {
      url: "https://docs.google.com/d/1",
      title: "Q3 Invoice",
      tabId: 9,
    });
    expect((await threadTabs(first)).map((t) => t.url)).toEqual([
      "https://docs.google.com/d/1",
      "https://mail.google.com/",
    ]);

    // Re-driving a tab moves it back to the front instead of duplicating it.
    await recordDrivenTabFor(first, { url: "https://mail.google.com/", title: "Inbox", tabId: 7 });
    expect((await threadTabs(first)).map((t) => t.url)).toEqual([
      "https://mail.google.com/",
      "https://docs.google.com/d/1",
    ]);

    // Later appends rewrite the index row without dropping the list.
    await appendMessageTo(first, msg("assistant", "done"));
    expect(await threadTabs(first)).toHaveLength(2);

    // Tabs belong to their own conversation — a second thread starts clean.
    const second = await appendMessageFresh(msg("user", "unrelated task"));
    expect(await threadTabs(second)).toEqual([]);
    expect(await threadTabs(first)).toHaveLength(2);
  });

  it("keeps the record when the run's closing writes land in the same tick", async () => {
    // How a run actually ends: the transcript writer fires its closing append
    // fire-and-forget and start-run records the driven tab right behind it.
    // Both rewrite the index row, so an unserialized record loses the whole
    // list to theirs — and a thread that forgets its strip mints a new one on
    // every follow-up.
    const id = await appendMessageFresh(msg("user", "book a flight"));
    void appendMessageTo(id, msg("assistant", "booked"));
    await recordDrivenTabFor(id, { url: "https://air.test/", title: "Air", tabId: 4, groupId: 7 });
    await appendMessageTo(id, msg("assistant", "done"));

    expect(await threadTabs(id)).toEqual([
      { url: "https://air.test/", title: "Air", tabId: 4, groupId: 7 },
    ]);
  });

  it("remembers what the strip held, apart from the tab the run drove", async () => {
    // The strip's membership answers a different question than the driven-tab
    // list — "which group is this thread's" — and holds pages the run only
    // filed. Keeping it out of `tabs` keeps filed reference pages out of the
    // model's "earlier work" line and out of that list's tighter cap.
    const id = await appendMessageFresh(msg("user", "copy from the doc"));
    await recordDrivenTabFor(id, { url: "https://air.test/", title: "Air", tabId: 4, groupId: 7 }, [
      "https://air.test/",
      "https://docs.test/spec",
    ]);

    expect((await getThreadTabsFor(id)).stripUrls).toEqual([
      "https://air.test/",
      "https://docs.test/spec",
    ]);
    expect(await threadTabs(id)).toHaveLength(1);
  });

  it("a run with no strip leaves the thread's last known one standing", async () => {
    // A read-only run groups nothing, so it has no membership to report —
    // erasing the record would cost the thread the only key that survives a
    // restart, and the next run would mint a second strip beside the first.
    const id = await appendMessageFresh(msg("user", "check the page"));
    await recordDrivenTabFor(id, { url: "https://air.test/", title: "Air", groupId: 7 }, [
      "https://air.test/",
      "https://docs.test/spec",
    ]);
    await recordDrivenTabFor(id, { url: "https://news.test/", title: "News" });

    expect((await getThreadTabsFor(id)).stripUrls).toEqual([
      "https://air.test/",
      "https://docs.test/spec",
    ]);
  });

  it("caps the strip snapshot too — a big working set stays bounded", async () => {
    const id = await appendMessageFresh(msg("user", "many tabs"));
    const urls = Array.from({ length: 14 }, (_, i) => `https://filed${i}.test/`);
    await recordDrivenTabFor(id, { url: urls[0] ?? "", title: "First" }, urls);
    expect((await getThreadTabsFor(id)).stripUrls).toHaveLength(10);
  });

  it("caps the tab list so a long multi-tab session stays bounded", async () => {
    const id = await appendMessageFresh(msg("user", "many tabs"));
    for (let i = 0; i < 8; i++) {
      await recordDrivenTabFor(id, { url: `https://site${i}.com/`, title: `Site ${i}` });
    }
    const tabs = await threadTabs(id);
    expect(tabs).toHaveLength(5);
    expect(tabs[0]?.url).toBe("https://site7.com/"); // newest work first
    expect(tabs.map((t) => t.url)).not.toContain("https://site2.com/"); // oldest evicted
  });
});

/**
 * The plan card is state, not append-only history: revisions rewrite it in
 * place. When the card it would rewrite has fallen out of the transcript cap
 * (a very long run), the revision appends instead of vanishing.
 */
describe("replaceMessageTo", () => {
  it("rewrites the card in place", async () => {
    const id = await appendMessageFresh(msg("user", "add the ingress rule"));
    const card = msg("plan", "");
    await appendMessageTo(id, card);

    await replaceMessageTo(id, { ...card, steps: ["revised"], current: 1 });

    const stored = await getMessages(id);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ id: card.id, steps: ["revised"], current: 1 });
  });

  it("appends when the card it would rewrite is already gone from the cap", async () => {
    const id = await appendMessageFresh(msg("user", "add the ingress rule"));
    const evicted = msg("plan", "");
    await appendMessageTo(id, evicted);
    // Push the card past the ceiling with spine messages — step rows are pruned
    // above the recent window, so they never crowd a plan card out.
    for (let i = 0; i < MAX_MESSAGES; i++) {
      await appendMessageTo(id, msg("assistant", `turn ${i}`));
    }
    expect(await getMessages(id)).toHaveLength(MAX_MESSAGES);
    expect((await getMessages(id)).some((m) => m.id === evicted.id)).toBe(false);

    const revised = { ...evicted, steps: ["revised"], current: 1 };
    await replaceMessageTo(id, revised);

    const stored = await getMessages(id);
    // The revision landed (at the tail) instead of being dropped, and the cap
    // held: the oldest message made room for it.
    expect(stored.some((m) => m.id === revised.id && m.steps?.length === 1)).toBe(true);
    expect(stored).toHaveLength(MAX_MESSAGES);
  });
});

/**
 * The standing plan approval is conversation state: it survives an unrelated
 * patch, and a revision clears it instead of letting the old yes ride along.
 */
describe("approved plan", () => {
  it("round-trips, survives an unrelated meta write, and clears on null", async () => {
    const id = await appendMessageFresh(msg("user", "book a table"));
    await recordApprovedPlan(id, ["Open the site", "Book the table"]);
    await recordEngine(id, { providerId: "p1" });

    let meta = (await listConversations()).find((c) => c.id === id);
    expect(meta?.approvedPlan).toEqual(["Open the site", "Book the table"]);
    expect(meta?.engine).toEqual({ providerId: "p1" });

    await recordApprovedPlan(id, null);
    meta = (await listConversations()).find((c) => c.id === id);
    expect(meta?.approvedPlan).toBeUndefined();
    expect(meta?.engine).toEqual({ providerId: "p1" }); // untouched
  });

  it("ignores a conversation that is gone rather than resurrecting it", async () => {
    await recordApprovedPlan("never-existed", ["Do X"]);
    expect((await listConversations()).some((c) => c.id === "never-existed")).toBe(false);
  });
});

/**
 * The engine pick is conversation state: it survives an unrelated patch, and a
 * schedule's thread is born already carrying the pick it was set up with.
 */
describe("engine pin", () => {
  it("round-trips and survives an unrelated meta write", async () => {
    const id = await appendMessageFresh(msg("user", "book a table"));
    await recordEngine(id, { providerId: "p1", model: "claude-x" });
    await recordDrivenTabFor(id, { url: "https://site.com/", title: "Site" });

    const meta = (await listConversations()).find((c) => c.id === id);
    expect(meta?.engine).toEqual({ providerId: "p1", model: "claude-x" });
    expect(meta?.tabs?.[0]?.url).toBe("https://site.com/");
  });

  it("ignores a conversation that is gone rather than resurrecting it", async () => {
    await recordEngine("never-existed", { providerId: "p1" });
    expect((await listConversations()).some((c) => c.id === "never-existed")).toBe(false);
  });

  it("seeds a schedule's thread with the pick it was set up with", async () => {
    await openScheduledConversation("s1", "Scheduled", { providerId: "p1", effort: "low" });
    const meta = (await listConversations()).find((c) => c.id === "s1");
    expect(meta?.engine).toEqual({ providerId: "p1", effort: "low" });

    // Re-created after eviction, it keeps what it already had — the second
    // call must not overwrite a pin the user has since changed.
    await recordEngine("s1", { providerId: "p2" });
    await openScheduledConversation("s1", "Scheduled", { providerId: "p1", effort: "low" });
    expect((await listConversations()).find((c) => c.id === "s1")?.engine).toEqual({
      providerId: "p2",
    });
  });
});
