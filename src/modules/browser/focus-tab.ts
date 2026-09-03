import { createLogger } from "@/lib/logger";

const log = createLogger("tabs");

/**
 * Bring a tab forward — its window first, then the tab inside it, so the window
 * never flashes whatever tab it was last on. The one way to put a tab on screen:
 * the panel's chips and the driver's watched `switch_tab` follow land here.
 * Best-effort: a tab that died surfaces through the run itself, and a gone
 * board entry drops out on the next transition.
 *
 * `pullWindow: false` activates the tab inside its window but never raises the
 * window itself — the agent's one move (the watched switch_tab follow) must not
 * yank Chrome out of another app. A user's own click (chips, the board) keeps
 * the pull: they are right there, asking to see the tab.
 */
export async function focusTab(
  tabId: number,
  windowId?: number,
  opts: { pullWindow?: boolean } = {},
): Promise<boolean> {
  try {
    const win = windowId ?? (await chrome.tabs.get(tabId)).windowId;
    if (win !== undefined && opts.pullWindow !== false) {
      await chrome.windows.update(win, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    // The tab is gone — the caller decides whether the page can stand in for it.
    return false;
  }
}

/**
 * Put a PAGE on screen — the tab while it lives, the url once it doesn't. What
 * the user clicks is a chip naming a page, and that chip outlives the tab it
 * was minted from: the settled band keeps the conversation's last one for as
 * long as the thread exists. A click that silently did nothing was therefore
 * the common ending, not the edge case — the tab id in hand is stale far more
 * often than it is live.
 *
 * A tab already sitting on that url is reused before a new one is opened: the
 * chip stays clickable forever, and forever must not mean a drawer of
 * duplicates. Matched by hand rather than `tabs.query({ url })` — that argument
 * takes match patterns, and a real url with a query string is not one.
 */
export async function revealTab(target: {
  tabId?: number;
  windowId?: number;
  url?: string;
}): Promise<void> {
  if (target.tabId !== undefined && (await focusTab(target.tabId, target.windowId))) return;
  const { url } = target;
  if (!url) return;
  try {
    const open = (await chrome.tabs.query({})).find((t) => t.url === url && t.id !== undefined);
    if (open?.id !== undefined) {
      await focusTab(open.id, open.windowId);
      return;
    }
    // Active, and in the window the click came from — the panel's. Reopening a
    // page you asked to see behind whatever you are looking at would be a tab
    // you have to go find.
    await chrome.tabs.create({ url, active: true });
  } catch (e) {
    log.debug("reopen skipped:", e instanceof Error ? e.message : String(e));
  }
}
