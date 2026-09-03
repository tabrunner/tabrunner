import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  continuesThreadTab,
  createRunGroup,
  labelRunTab,
  liveThreadGroup,
  reopenTargetFor,
  settleRunTab,
} from "../start-run";
import type { LastTab } from "@/modules/conversation/conversations";

// One thread, one strip per window: follow-up messages file their tab under the
// group the thread already has in that window — found by content (the urls the
// thread drove), not by remembered ids, which a browser restart recycles.

const recorded = (tabId: number, groupId?: number): LastTab => ({
  url: `https://example.com/${tabId}`,
  title: `tab ${tabId}`,
  tabId,
  ...(groupId !== undefined ? { groupId } : {}),
});

// A chrome.tabs.Tab needs a dozen fields the shortcut never reads.
const tabOn = (url: string, groupId: number, windowId = 1) =>
  ({ url, groupId, windowId }) as unknown as chrome.tabs.Tab;

/** The window's active tab the run is about to drive — ungrouped, unrelated. */
const runTab = () => tabOn("https://unrelated.example", -1);

const ourStrip = (windowId = 1) => ({ title: "book the flight", color: "green", windowId });

/** The stored thread record: driven tabs, plus what the strip held at settle. */
const thread = (tabs: LastTab[], stripUrls: string[] = []) => ({ tabs, stripUrls });

describe("continuesThreadTab", () => {
  // A follow-up typed elsewhere is usually steering from wherever the user
  // happens to be reading — the side panel stays open across tab switches —
  // not a move order. The conversation's own tab outranks the send-time one.
  it("a panel run always wants the thread's tab back", () => {
    expect(continuesThreadTab("panel", false)).toBe(true);
    expect(continuesThreadTab("panel", true)).toBe(true);
  });

  it("other owners return only for a parked answer", () => {
    expect(continuesThreadTab("schedule", false)).toBe(false);
    expect(continuesThreadTab("bridge", false)).toBe(false);
    expect(continuesThreadTab("schedule", true)).toBe(true);
    expect(continuesThreadTab("bridge", true)).toBe(true);
  });
});

describe("reopenTargetFor", () => {
  const page = "https://example.com/checkout";

  it("a schedule fire puts its own page back — nobody is there to press Retry", () => {
    expect(reopenTargetFor("schedule", false, page)).toBe(page);
  });

  it("once per run: a page that closes itself must not spin the run", () => {
    expect(reopenTargetFor("schedule", true, page)).toBeUndefined();
  });

  it("a run with a person at the browser ends instead — the close was the answer", () => {
    // Panel and bridge alike: a bridge run is dispatched from an editor with
    // the browser in reach, so closing its tab is as deliberate as it gets.
    expect(reopenTargetFor("panel", false, page)).toBeUndefined();
    expect(reopenTargetFor("bridge", false, page)).toBeUndefined();
  });

  it("nothing worth reopening is nothing to reopen", () => {
    expect(reopenTargetFor("schedule", false, undefined)).toBeUndefined();
    // A blank tab is not a page, and a restricted one could not be driven —
    // either would put up a tab nobody asked for.
    expect(reopenTargetFor("schedule", false, "about:blank")).toBeUndefined();
    expect(reopenTargetFor("schedule", false, "chrome://settings")).toBeUndefined();
  });
});

describe("thread tab group", () => {
  const chromeBackup = globalThis.chrome;
  let tabsGet: ReturnType<typeof vi.fn>;
  let tabsQuery: ReturnType<typeof vi.fn>;
  let tabsGroup: ReturnType<typeof vi.fn>;
  let groupGet: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tabsGet = vi.fn().mockResolvedValue({ groupId: -1 });
    tabsQuery = vi.fn().mockResolvedValue([]);
    tabsGroup = vi.fn();
    groupGet = vi.fn();
    groupUpdate = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).chrome = {
      ...chromeBackup,
      tabs: { ...chromeBackup.tabs, get: tabsGet, query: tabsQuery, group: tabsGroup },
      tabGroups: { get: groupGet, update: groupUpdate },
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).chrome = chromeBackup;
  });

  describe("liveThreadGroup", () => {
    it("is undefined without a recorded group", async () => {
      expect(await liveThreadGroup(thread([]), runTab())).toBeUndefined();
      // Bare urls with no group recorded.
      expect(await liveThreadGroup(thread([recorded(1), recorded(2)]), runTab())).toBeUndefined();
      expect(groupGet).not.toHaveBeenCalled();
    });

    it("is the newest recorded group that is still alive, ours, and in this window", async () => {
      groupGet.mockResolvedValue(ourStrip());
      const tabs = [recorded(1, 7), recorded(2, 9)];
      expect(await liveThreadGroup(thread(tabs), runTab())).toBe(7);
      // Newest first: the older record is never even checked.
      expect(groupGet).toHaveBeenCalledTimes(1);
      expect(groupGet).toHaveBeenCalledWith(7);
    });

    it("outlives the tab that earned the record — strips outlive their tabs", async () => {
      // The driven tab was closed once the task ended; the strip of group_tab'd
      // tabs lives on. A live recorded group IS the thread's — minting a second
      // one alongside it is the bug this fixes. No window scan is even made.
      groupGet.mockResolvedValue(ourStrip());
      expect(await liveThreadGroup(thread([recorded(1, 7)]), runTab())).toBe(7);
      expect(tabsQuery).not.toHaveBeenCalled();
    });

    it("skips dead groups, dedupes records, and falls to older ones", async () => {
      groupGet
        .mockRejectedValueOnce(new Error("No group with id: 7"))
        .mockResolvedValueOnce(ourStrip());
      const tabs = [recorded(1, 7), recorded(2, 7), recorded(3, 9)];
      expect(await liveThreadGroup(thread(tabs), runTab())).toBe(9);
      expect(groupGet).toHaveBeenCalledTimes(2); // 7 checked once, then 9
    });

    it("is undefined when every recorded group is gone and the window holds none", async () => {
      groupGet.mockRejectedValue(new Error("No group"));
      expect(
        await liveThreadGroup(thread([recorded(1, 7), recorded(2, 9)]), runTab()),
      ).toBeUndefined();
    });

    it("keeps the group the tab in hand already sits in when the thread drove its url", async () => {
      // The records are all stale (closed tabs, a browser restart) — the tab
      // itself is the proof: the conversation drove this url, and it still
      // sits grouped. Minting a second group around it is the bug this fixes.
      groupGet.mockImplementation((id: number) =>
        id === 4 ? Promise.resolve(ourStrip()) : Promise.reject(new Error("No group with id")),
      );
      const tabs = [recorded(1, 7)];
      const onIt = tabOn("https://example.com/1", 4);
      expect(await liveThreadGroup(thread(tabs), onIt)).toBe(4);
    });

    it("ignores the tab in hand's group when the thread never drove its url", async () => {
      // A url the conversation never touched, sitting in a group of the user's
      // own — that group is theirs, not the thread's. Fall to the records.
      groupGet.mockResolvedValue(ourStrip());
      const onIt = tabOn("https://unrelated.example", 4);
      expect(await liveThreadGroup(thread([recorded(1, 7)]), onIt)).toBe(7);
    });

    it("ignores an ungrouped tab in hand", async () => {
      groupGet.mockResolvedValue(ourStrip());
      const onIt = tabOn("https://example.com/1", -1);
      expect(await liveThreadGroup(thread([recorded(1, 7)]), onIt)).toBe(7);
    });

    it("finds the strip by content after a restart killed the recorded ids", async () => {
      // Session restore recreated the strip under a fresh id: the record's 7 is
      // dead, but the window still holds a grouped tab on a url the thread drove.
      groupGet.mockImplementation((id: number) =>
        id === 21 ? Promise.resolve(ourStrip()) : Promise.reject(new Error("No group with id")),
      );
      tabsQuery.mockResolvedValue([{ url: "https://example.com/1", groupId: 21 }]);
      expect(await liveThreadGroup(thread([recorded(1, 7)]), runTab())).toBe(21);
    });

    it("finds the strip by a filed tab when the driven one is gone", async () => {
      // The case the driven-tab list alone cannot answer: the user closed the
      // finished tab, a restart killed every id, and the strip is standing on
      // a page `group_tab` filed — a url `tabs` never records.
      groupGet.mockImplementation((id: number) =>
        id === 21 ? Promise.resolve(ourStrip()) : Promise.reject(new Error("No group with id")),
      );
      tabsQuery.mockResolvedValue([{ url: "https://docs.test/spec", groupId: 21 }]);
      const stored = thread([recorded(1, 7)], ["https://example.com/1", "https://docs.test/spec"]);
      expect(await liveThreadGroup(stored, runTab())).toBe(21);
    });

    it("still refuses a filed url sitting in a group that isn't ours", async () => {
      // The wider net must not widen what counts as ours: the user filed the
      // doc into their own group after the run ended.
      groupGet.mockResolvedValue({ title: "reading list", color: "grey", windowId: 1 });
      tabsQuery.mockResolvedValue([{ url: "https://docs.test/spec", groupId: 21 }]);
      const stored = thread([recorded(1, 7)], ["https://docs.test/spec"]);
      expect(await liveThreadGroup(stored, runTab())).toBeUndefined();
    });

    it("does not follow a live recorded group into another window", async () => {
      // One strip per conversation PER WINDOW — Chrome groups can't span
      // windows, so the window 2 strip is no seed for a window 1 run.
      groupGet.mockResolvedValue(ourStrip(2));
      expect(await liveThreadGroup(thread([recorded(1, 7)]), runTab())).toBeUndefined();
    });

    it("never adopts a group that isn't ours, however it was found", async () => {
      // The user built their own grey group around a page the thread drove:
      // not a strip, never renamed or joined — from any of the three passes.
      groupGet.mockImplementation((id: number) =>
        id === 4
          ? Promise.resolve({ title: "mine", color: "grey", windowId: 1 })
          : Promise.reject(new Error("No group with id")),
      );
      const onIt = tabOn("https://example.com/1", 4);
      tabsQuery.mockResolvedValue([{ url: "https://example.com/1", groupId: 4 }]);
      expect(await liveThreadGroup(thread([recorded(1, 7)]), onIt)).toBeUndefined();
    });

    it("a restarted browser's recycled id pointing at a foreign group is skipped", async () => {
      // The record's 7 died with last session; this session's group 7 is the
      // user's. Liveness alone would rename a stranger's group.
      groupGet.mockResolvedValue({ title: "vacation pics", color: "blue", windowId: 1 });
      expect(await liveThreadGroup(thread([recorded(1, 7)]), runTab())).toBeUndefined();
    });

    it("a settled strip is recognized by its mark even without the green", async () => {
      groupGet.mockResolvedValue({ title: "✓ book the flight", color: "grey", windowId: 1 });
      expect(await liveThreadGroup(thread([recorded(1, 7)]), runTab())).toBe(7);
    });
  });

  describe("labelRunTab", () => {
    it("mints a fresh group when the thread has none", async () => {
      tabsGroup.mockResolvedValue(7);
      expect(await labelRunTab(42, "book the flight")).toBe(7);
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42 });
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "book the flight",
        color: "green",
        collapsed: false,
      });
    });

    it("files the tab under the thread's live group", async () => {
      tabsGroup.mockResolvedValue(7);
      expect(await labelRunTab(42, "book the flight", 7)).toBe(7);
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42, groupId: 7 });
      expect(tabsGroup).toHaveBeenCalledTimes(1);
    });

    it("falls back to a fresh group when the thread's is gone", async () => {
      tabsGroup.mockRejectedValueOnce(new Error("No group with id: 7")).mockResolvedValue(8);
      expect(await labelRunTab(42, "book the flight", 7)).toBe(8);
      expect(tabsGroup).toHaveBeenLastCalledWith({ tabIds: 42 });
    });

    it("never fails a run over grouping", async () => {
      tabsGroup.mockRejectedValue(new Error("cannot group"));
      expect(await labelRunTab(42, "book the flight")).toBeUndefined();
      expect(groupUpdate).not.toHaveBeenCalled();
    });

    it("keeps the parked strip's name on a continuation, unmarking it", async () => {
      // The continuation's task is the answer fragment — the strip keeps naming
      // the task the question was about.
      tabsGroup.mockResolvedValue(7);
      groupGet.mockResolvedValue({ title: "? book the flight" });
      expect(await labelRunTab(42, "yes, the March one", 7, true)).toBe(7);
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "book the flight",
        color: "green",
        collapsed: false,
      });
    });

    it("names a freshly minted strip after the task even on a continuation", async () => {
      tabsGroup.mockResolvedValue(7);
      groupGet.mockResolvedValue({}); // a minted group carries no name
      expect(await labelRunTab(42, "yes, the March one", undefined, true)).toBe(7);
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "yes, the March one",
        color: "green",
        collapsed: false,
      });
    });
  });

  describe("settleRunTab", () => {
    it("re-marks the name the group already carries, not the task at hand", async () => {
      // A continuation's task is the user's answer fragment — the strip keeps
      // naming the task the question was about.
      groupGet.mockResolvedValue({ title: "book the flight" });
      await settleRunTab(7, "yes, the March one", "done");
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "✓ book the flight",
        collapsed: true,
      });
    });

    it("replaces the mark a previous run left", async () => {
      groupGet.mockResolvedValue({ title: "? book the flight" });
      await settleRunTab(7, "yes, the March one", "done");
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "✓ book the flight",
        collapsed: true,
      });
    });

    it("falls back to the task when the group carries no name", async () => {
      groupGet.mockResolvedValue({});
      await settleRunTab(7, "book the flight", "failed");
      expect(groupUpdate).toHaveBeenCalledWith(7, {
        title: "✗ book the flight",
        collapsed: true,
      });
    });

    it("never fails a run over a dead group", async () => {
      groupGet.mockRejectedValue(new Error("No group with id: 7"));
      await settleRunTab(7, "book the flight", "done");
      expect(groupUpdate).not.toHaveBeenCalled();
    });
  });

  describe("createRunGroup", () => {
    const runGroupFor = (over: Partial<Parameters<typeof createRunGroup>[0]> = {}) =>
      createRunGroup({
        task: "book the flight",
        keepName: false,
        drivenTabId: () => 42,
        ...over,
      });

    it("mints the strip around the driven tab on the first action", async () => {
      tabsGroup.mockResolvedValue(7);
      const rg = runGroupFor();
      expect(rg.groupId).toBeUndefined();
      await rg.touch();
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42 });
      expect(rg.groupId).toBe(7);
    });

    it("files later touches into the same strip", async () => {
      tabsGroup.mockResolvedValue(7);
      const driven = { id: 42 };
      const rg = runGroupFor({ drivenTabId: () => driven.id });
      await rg.touch();
      driven.id = 43; // the run switched tabs mid-flight
      await rg.touch();
      expect(tabsGroup).toHaveBeenLastCalledWith({ tabIds: 43, groupId: 7 });
    });

    it("joins the thread's seed strip when one was resolved", async () => {
      tabsGroup.mockResolvedValue(7);
      const rg = runGroupFor({ seedGroupId: 5 });
      await rg.touch();
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42, groupId: 5 });
    });

    it("retitles the seed the tab already sits in, without moving it", async () => {
      tabsGet.mockResolvedValue({ groupId: 5 });
      tabsGroup.mockResolvedValue(5);
      const rg = runGroupFor({ seedGroupId: 5 });
      await rg.touch();
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42, groupId: 5 });
      expect(rg.groupId).toBe(5);
    });

    it("never groups a tab already sitting in a group that isn't the seed", async () => {
      // Any run, not just continuations: a group the user (or another chat)
      // owns is left exactly as it is.
      tabsGet.mockResolvedValue({ groupId: 3 });
      const rg = runGroupFor({ seedGroupId: 5 });
      await rg.touch();
      expect(tabsGroup).not.toHaveBeenCalled();
      expect(rg.groupId).toBeUndefined();
    });

    it("never mints around a grouped tab even with no seed at all", async () => {
      tabsGet.mockResolvedValue({ groupId: 3 }); // a group of the user's own
      const rg = runGroupFor({ keepName: true });
      await rg.touch();
      expect(tabsGroup).not.toHaveBeenCalled();
      expect(rg.groupId).toBeUndefined();
    });

    it("mints for a continuation whose tab sits ungrouped", async () => {
      tabsGroup.mockResolvedValue(7);
      const rg = runGroupFor({ keepName: true });
      await rg.touch();
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 42 });
    });

    it("stays silent when a later touch can't join — no second strip", async () => {
      tabsGroup.mockResolvedValueOnce(7).mockRejectedValue(new Error("different window"));
      const driven = { id: 42 };
      const rg = runGroupFor({ drivenTabId: () => driven.id });
      await rg.touch();
      driven.id = 43;
      await rg.touch(); // cross-window: no throw, no fresh mint
      expect(rg.groupId).toBe(7);
      expect(tabsGroup).toHaveBeenCalledTimes(2);
    });

    it("file mints the strip around the filed tab and returns its id", async () => {
      tabsGroup.mockResolvedValue(9);
      const rg = runGroupFor();
      await expect(rg.file(55)).resolves.toBe(9);
      expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 55 });
    });

    it("file leaves a tab in somebody else's group alone", async () => {
      // group_tab on a tab the user already filed: no strip is worth ripping
      // their arrangement — the tool gets no group and reports the failure.
      tabsGet.mockResolvedValue({ groupId: 3 });
      const rg = runGroupFor();
      await expect(rg.file(55)).resolves.toBeUndefined();
      expect(tabsGroup).not.toHaveBeenCalled();
    });
  });
});
