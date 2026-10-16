import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRun, getActiveRun, releaseRun } from "@/modules/agent/active-runs";

/**
 * The session's own logic — who may hold the browser, and whether an action
 * hands back refs that are still valid. The browser itself is mocked: what is
 * worth pinning here is the lock and the snapshot-attach, not CDP.
 */

const executeTool = vi.fn();
vi.mock("@/modules/agent/tools", () => ({
  executeTool: (...a: unknown[]) => executeTool(...a),
  formatSuccessSummary: () => "did the thing",
  formatDetail: () => undefined,
}));
vi.mock("@/modules/browser", () => ({
  createDriver: () => ({}),
  showAgentIndicator: () => Promise.resolve(),
  hideAgentIndicator: () => Promise.resolve(),
  detachAll: () => Promise.resolve(),
  isRestrictedUrl: (url?: string) => url?.startsWith("chrome://") ?? false,
  waitForLoad: (...a: unknown[]) => waitForLoad(...a),
}));
const waitForLoad = vi.fn();

const { DirectSession } = await import("../direct");

/** The user's own tab — what `background: false` asks for. */
const ON_SCREEN = { background: false };

const created: string[] = [];
const removed: number[] = [];
let queried = 0;

beforeEach(() => {
  created.length = 0;
  removed.length = 0;
  queried = 0;
  waitForLoad.mockReset();
  waitForLoad.mockResolvedValue(undefined);
  executeTool.mockReset();
  executeTool.mockResolvedValue({ ok: true, data: { pageContent: "[ref=e1] button" } });
  (globalThis.chrome as unknown as Record<string, unknown>).tabs = {
    query: () => {
      queried += 1;
      return Promise.resolve([{ id: 7, windowId: 1, title: "Inbox", url: "https://x.test/" }]);
    },
    create: ({ url }: { url: string }) => {
      created.push(url);
      return Promise.resolve({ id: 42 });
    },
    remove: (id: number) => {
      removed.push(id);
      return Promise.resolve();
    },
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  };
});

afterEach(() => {
  const run = getActiveRun();
  if (run) releaseRun(run);
});

describe("DirectSession", () => {
  it("opens on the active tab when asked to, and hands back the first snapshot", async () => {
    const session = new DirectSession();
    const result = await session.start("find the invoice", "Claude Code", ON_SCREEN);

    expect(result.ok).toBe(true);
    expect(session.open).toBe(true);
    expect(session.drivenTab).toBe(7);
    // The opening move is always a look — spending a round trip on it is waste.
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "snapshot" }),
      expect.anything(),
    );
  });

  it("refuses to open while the panel is driving, and says where the run is", async () => {
    const claim = acquireRun("panel-conversation", "panel");
    expect(claim.ok).toBe(true);

    const session = new DirectSession();
    // One browser, one driver — and the refusal has to name the holder, or the
    // client has no idea what to do next.
    await expect(session.start("do a thing", "Claude Code", ON_SCREEN)).rejects.toThrow(/panel/i);
    expect(session.open).toBe(false);
  });

  it("hands the browser back when it ends", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", ON_SCREEN);
    await session.end();

    expect(session.open).toBe(false);
    expect(getActiveRun()).toBeNull();
    // The slot is free, so the panel can run again.
    expect(acquireRun("panel-conversation", "panel").ok).toBe(true);
  });

  it("fires onClose when the session ends", async () => {
    const onClose = vi.fn();
    const session = new DirectSession(onClose);
    await session.start("a goal", "Claude Code", ON_SCREEN);
    await session.end();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when an idle session expires, so the browser is not claimed forever", async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const session = new DirectSession(onClose);
      await session.start("a goal", "Claude Code", ON_SCREEN);
      expect(onClose).not.toHaveBeenCalled();

      // 5 minutes of silence — the expiry calls end() asynchronously; flush the
      // microtask queue for the hide-indicator await before asserting.
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await Promise.resolve();
      await Promise.resolve();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(session.open).toBe(false);
      expect(getActiveRun()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a client that never opened a session what to do", async () => {
    const session = new DirectSession();
    await expect(session.act("click", { ref: "e1" })).rejects.toThrow(/browser_start/);
  });

  it("re-snapshots after a mutating action, because refs go stale", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", ON_SCREEN);
    executeTool.mockClear();
    executeTool.mockResolvedValue({ ok: true, data: { pageContent: "[ref=e9] link" } });

    const result = await session.act("click", { ref: "e1" });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[1]?.[0]).toMatchObject({ name: "snapshot" });
    expect((result.data as { pageContent: string }).pageContent).toBe("[ref=e9] link");
  });

  it("does not re-snapshot after a read", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", ON_SCREEN);
    executeTool.mockClear();

    await session.act("list_tabs", {});

    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("leaves out the page when the client says it does not want it", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", ON_SCREEN);
    executeTool.mockClear();
    executeTool.mockResolvedValue({ ok: true, data: { x: 1, y: 2 } });

    const result = await session.act("click", { ref: "e1" }, false);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ x: 1, y: 2 });
  });
});

// The snapshot goes to the client, so a session must not be handed the page
// the user is reading unless the client chose that.
describe("DirectSession start", () => {
  it("works a tab of its own by default and never looks at the user's", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", { background: true });

    expect(created).toEqual(["https://www.google.com"]);
    expect(session.drivenTab).toBe(42);
    expect(queried).toBe(0);
  });

  it("opens the page it was told to", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", { url: "https://x.test/a", background: true });

    expect(created).toEqual(["https://x.test/a"]);
  });

  it("a URL never adopts the user's tab, even with background off", async () => {
    const session = new DirectSession();
    await session.start("a goal", "Claude Code", { url: "https://x.test/a", background: false });

    expect(created).toEqual(["https://x.test/a"]);
    expect(queried).toBe(0);
  });

  it("refuses a page the browser forbids extensions on, before opening anything", async () => {
    const session = new DirectSession();
    await expect(
      session.start("a goal", "Claude Code", { url: "chrome://settings", background: true }),
    ).rejects.toThrow(/cannot read this page/);

    expect(created).toEqual([]);
    expect(session.open).toBe(false);
  });

  it("closes the tab it opened when the page never loads", async () => {
    waitForLoad.mockRejectedValue(new Error("slow"));
    const session = new DirectSession();

    await expect(session.start("a goal", "Claude Code", { background: true })).rejects.toThrow(
      "slow",
    );
    expect(removed).toEqual([42]);
    expect(getActiveRun()).toBeNull();
  });
});
