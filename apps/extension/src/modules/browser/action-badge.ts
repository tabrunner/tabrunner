/**
 * The toolbar badge — the ONE run signal that never depends on injection.
 *
 * Everything else that says "TabRunner is working" is painted into a page and
 * is therefore best-effort: the driven tab's badge and favicon dot, and the
 * floating pill, all go through `chrome.scripting.executeScript`, which a
 * restricted page, a PDF viewer, a `file://` URL without file access, or a
 * hostile CSP can refuse — silently, since a run must never fail because its
 * marks could not be drawn. The pill has a second hole: the user can turn it
 * off for good (`widgetHidden`), and it deliberately skips the driven tab,
 * which under tab adoption IS the tab the user is looking at.
 *
 * So closing the panel could leave nothing on screen at all. This is the floor
 * under that: painted by the browser itself, on every page type, whatever the
 * pref says. Alongside the run's green tab group (also injection-free), it
 * means "did my task keep running?" always has an answer within a glance.
 *
 * Count, not a dot, because the number is the part no other surface carries
 * once the panel is closed — one run, or four waiting behind it. Parked on the
 * user it becomes "?", the same wait language the favicon and the pill speak.
 * And when a run fails with nobody watching, a red "!" takes over once the
 * count clears: every other trace of that failure is gone by then — the marks
 * are pulled with the run, and the notification is one dismiss from lost.
 *
 * Pre-digested by the worker, like `WidgetState` — this module never reads the
 * board itself, so nothing under `browser/` depends on `agent/`.
 */

import { i18n } from "@/i18n";

/** Amber = alive/working, the favicon dot's own colour; dark text for contrast. */
const BADGE_BG = "#fbbf24";
const BADGE_FG = "#451a03";
/** Red = it failed and you were not there to see it — the panel's error colour. */
const FAIL_BG = "#dc2626";
const FAIL_FG = "#ffffff";

export interface BadgeState {
  /**
   * The running run is documenting itself. The badge's text slot is spoken for
   * (count / "?" / "!"), so REC rides the tooltip instead — the injection-free
   * floor still says it, which is what a panelless scheduled run needs.
   */
  recording?: boolean;
  /** Parked on the user's answer — the count becomes the wait language's "?". */
  awaiting?: boolean;
  /**
   * A run failed while nobody was watching. Shown only once the work is done
   * (count 0): a live run outranks a past failure, and the failure is still
   * there when that run's count clears.
   */
  failed?: boolean;
}

/** `count` is running + queued; with nothing running and nothing unseen, clear. */
export async function syncActionBadge(count: number, state: BadgeState = {}): Promise<void> {
  const failed = count === 0 && state.failed === true;
  const text = count > 0 ? (state.awaiting ? "?" : String(count)) : failed ? "!" : "";
  try {
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: failed ? FAIL_BG : BADGE_BG });
      await chrome.action.setBadgeTextColor({ color: failed ? FAIL_FG : BADGE_FG });
    }
  } catch {
    // No toolbar to paint — the tab group still names the work.
  }
  // Last, and in its own try: REC is the least of what this badge says, and a
  // Chrome that refused the tooltip must not cost us the count. Restoring reads
  // the manifest's own message rather than an empty string (which leaves a
  // blank tooltip) or a copy of the words (which would drop the user's locale).
  try {
    await chrome.action.setTitle({
      title:
        state.recording === true
          ? i18n.t("walkthrough.badgeTitle")
          : chrome.i18n.getMessage("actionTitle"),
    });
  } catch {
    // Same floor: the badge itself is already painted.
  }
}
