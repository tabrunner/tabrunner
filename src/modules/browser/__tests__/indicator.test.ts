import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  paintFavicon,
  restoreFavicon,
  setMarksInert,
  stepFaviconFrame,
  showAgentIndicator,
  refreshAgentIndicator,
  hideAgentIndicator,
  settleAgentIndicator,
  waitAgentIndicator,
  clearAgentWait,
  withMarksClickThrough,
} from "../indicator";
import { paintWidget, removeWidget, type WidgetState } from "../status-widget";

// The page-side halves of the indicator, run directly in jsdom the way
// snapshot-script is tested — the chrome.scripting wrapper is a thin try/catch.
// The pill itself is the shared paintWidget (status-widget.test.ts); what is
// asserted here through it is the driven lifecycle's choice of state.

const ARGS = {
  hostId: "tabrunner-status-widget",
  linkId: "tabrunner-agent-favicon",
  restoreId: "tabrunner-agent-favicon-restore",
  dot: "data:image/svg+xml,dot",
};

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
}

function paint(favicon = ARGS.dot) {
  paintFavicon(ARGS.linkId, favicon, ARGS.restoreId);
}

function restore() {
  restoreFavicon(ARGS.linkId, ARGS.restoreId);
}

describe("favicon marks", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("appends the dot after the page's own icons so it wins the strip", () => {
    document.head.innerHTML = '<link rel="icon" href="/page-icon.png">';
    paint();

    const links = iconLinks();
    expect(links).toHaveLength(2);
    expect(links[links.length - 1]?.href).toBe(ARGS.dot); // last link wins in Chrome
  });

  it("painting twice leaves one dot, not a pile", () => {
    paint();
    paint();
    expect(iconLinks()).toHaveLength(1);
  });

  it("hands the favicon back to the page's own icon on restore", () => {
    document.head.innerHTML =
      '<link rel="icon" href="/old.png"><link rel="icon" href="/current.png">';
    paint();
    restore();

    // The page's own links stay untouched; a trailing restore link re-asserts
    // the one Chrome was showing — removal alone doesn't make Chrome re-resolve.
    const links = iconLinks();
    const back = links[links.length - 1];
    expect(links).toHaveLength(3);
    expect(back?.id).toBe(ARGS.restoreId);
    expect(back?.href.endsWith("/current.png")).toBe(true);
  });

  it("falls back to the root favicon.ico when the page declared no icon", () => {
    paint();
    restore();

    const links = iconLinks();
    expect(links).toHaveLength(1);
    expect(links[0]?.href.endsWith("/favicon.ico")).toBe(true);
  });

  it("a new paint clears the restore link before dotting again", () => {
    paint();
    restore();
    paint();
    expect(iconLinks()).toHaveLength(1);
    expect(iconLinks()[0]?.href).toBe(ARGS.dot);
  });

  it("holds the full frame under prefers-reduced-motion", () => {
    document.head.innerHTML = "";
    const link = document.createElement("link");
    link.id = ARGS.linkId;
    link.rel = "icon";
    link.href = ARGS.dot;
    document.head.appendChild(link);
    // jsdom never matches media features — stub the query itself.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
    })) as unknown as typeof window.matchMedia;
    try {
      stepFaviconFrame(ARGS.linkId, "data:image/svg+xml,dim");
      expect(link.href).toBe(ARGS.dot);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("worker-driven favicon heartbeat", () => {
  // The pulse lives in the worker because Chrome throttles hidden-tab timers
  // into silence — hidden is exactly when the strip signal matters.
  let executeScript: ReturnType<typeof vi.fn>;
  const chromeBackup = globalThis.chrome;

  beforeEach(() => {
    vi.useFakeTimers();
    executeScript = vi.fn().mockResolvedValue([]);
    (globalThis as Record<string, unknown>).chrome = {
      ...chromeBackup,
      scripting: { executeScript },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).chrome = chromeBackup;
  });

  const frameBeats = () =>
    executeScript.mock.calls.filter((c) => (c[0] as { func: unknown }).func === stepFaviconFrame);

  const paintCalls = () =>
    executeScript.mock.calls
      .filter((c) => (c[0] as { func: unknown }).func === paintWidget)
      .map((c) => (c[0] as { args: [string, WidgetState] }).args);

  const removeCalls = () =>
    executeScript.mock.calls.filter((c) => (c[0] as { func: unknown }).func === removeWidget);

  it("alternates two frames every beat while shown, and stops on hide", async () => {
    await showAgentIndicator(1);
    expect(frameBeats()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    const frames = frameBeats().map((c) => (c[0] as { args: string[] }).args[1]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).not.toBe(frames[1]); // full ↔ dim, one motion language

    await hideAgentIndicator(1);
    await vi.advanceTimersByTimeAsync(2800);
    expect(frameBeats()).toHaveLength(2); // no beats after hide
  });

  it("never beats on a page that refused the paint", async () => {
    // A PDF viewer, a file:// url without file access, a hostile CSP. The
    // heartbeat would fire an executeScript every 700ms forever, drawing
    // nothing — the tab group and the toolbar badge carry the signal there.
    executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
    await showAgentIndicator(9);
    await vi.advanceTimersByTimeAsync(2800);
    expect(frameBeats()).toHaveLength(0);

    // Navigating onto a page that does accept them picks the heartbeat back up.
    executeScript.mockResolvedValue([]);
    await refreshAgentIndicator(9);
    await vi.advanceTimersByTimeAsync(700);
    expect(frameBeats()).toHaveLength(1);
    await hideAgentIndicator(9);
  });

  it("wait marks the strip without a pulse, and clear removes the mark", async () => {
    await waitAgentIndicator(2);
    // No pulse beats, ever — the wait is a still state.
    await vi.advanceTimersByTimeAsync(2800);
    expect(frameBeats()).toHaveLength(0);
    // One paint, in the waiting state — the badge stays, saying it needs you.
    expect(paintCalls()).toHaveLength(1);
    expect(paintCalls()[0]?.[1].awaiting).toBe(true);

    // A repaint after a navigation lands the same waiting state, not "driving".
    await refreshAgentIndicator(2);
    expect(paintCalls()[1]?.[1].awaiting).toBe(true);

    // clear in a new run calls hideAgentIndicator → removeWidget.
    await clearAgentWait();
    expect(removeCalls()).toHaveLength(1);
  });

  it("show drives again on a waiting tab — wait is cleared, paint and restore follow", async () => {
    await waitAgentIndicator(3);

    await showAgentIndicator(3);
    // Both states paint the same pill; only `awaiting` differs, and an approved
    // plan puts the run back to work — waiting first, driving second.
    expect(paintCalls().map((c) => c[1].awaiting)).toEqual([true, false]);
    // hide runs normally once — no wait-specific cleanup, since show already cleared it.
    await hideAgentIndicator(3);
    expect(removeCalls()).toHaveLength(1);
  });

  it("a finished run settles into the receipt and leaves tracking", async () => {
    await showAgentIndicator(4);
    executeScript.mockClear();

    await settleAgentIndicator(4, "done");
    // Favicon back to the page, then the receipt in the pill's place — the
    // same ✓ the strip's group title wears, instead of a silent vanish.
    const settle = paintCalls()[0]?.[1];
    expect(settle?.settle).toEqual({ ok: true, text: expect.any(String) });
    expect(
      executeScript.mock.calls.some((c) => (c[0] as { func: unknown }).func === restoreFavicon),
    ).toBe(true);

    // The receipt self-clears page-side, so the tab is untracked: a navigation
    // repaint must not resurrect it.
    await refreshAgentIndicator(4);
    expect(paintCalls()).toHaveLength(1);
  });

  it("a failed run settles into the ✗ receipt", async () => {
    await settleAgentIndicator(5, "failed");
    expect(paintCalls()[0]?.[1].settle?.ok).toBe(false);
  });

  it("goes click-through while the agent clicks, so it can't eat its own click", async () => {
    const clicked = await withMarksClickThrough(6, () => Promise.resolve("done"));
    expect(clicked).toBe("done");
    const toggles = executeScript.mock.calls
      .filter((c) => (c[0] as { func: unknown }).func === setMarksInert)
      .map((c) => (c[0] as { args: unknown[] }).args[1]);
    expect(toggles).toEqual([true, false]);
  });

  it("restores the marks even when the click throws", async () => {
    await expect(
      withMarksClickThrough(7, () => Promise.reject(new Error("target gone"))),
    ).rejects.toThrow("target gone");
    const toggles = executeScript.mock.calls
      .filter((c) => (c[0] as { func: unknown }).func === setMarksInert)
      .map((c) => (c[0] as { args: unknown[] }).args[1]);
    expect(toggles).toEqual([true, false]);
  });
});
