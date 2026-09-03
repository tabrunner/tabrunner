import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { revealTab } from "@/modules/browser";
import { hostnameOf } from "@/lib/format";

/** Enough of a tab to name it and go there — the live run's, or a stored one. */
export interface TabChipTarget {
  tabId?: number;
  windowId?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
}

/**
 * Chip naming the tab a run is working — the panel is window-scoped and stays
 * open everywhere, so without this the run's target is invisible. Lives on the
 * live band, on its own row under the verb line (run context, same lifecycle as
 * the band): squeezed between the verb and the timer it truncated to a letter.
 * No dot of its own — the band's is the live signal. One click brings the tab
 * to the front — or the page back, when the tab is gone (revealTab): the chip
 * on the settled band names a page the user closed hours ago as often as a live
 * tab, and a chip that answers a click with nothing is a dead end wearing the
 * costume of a button.
 *
 * The settled band passes the conversation's last tab explicitly, so the row
 * survives the run that made it. It replaced a bare "Go to tab" button there:
 * the button spent a whole control saying only that a tab exists somewhere,
 * while the chip names WHICH tab and is just as clickable — a label and an
 * action in the space the label alone used to take.
 *
 * A filled pill, not bare text: favicon-then-title is the same shape as a
 * plan row (`○ step`), and directly above the plan peek the two read as one
 * list. The resting surface is what says "object you can press" instead of
 * "next item" — hover alone only works once you are already on it.
 *
 * It places itself: `self-start` so it sizes to its label inside the band's
 * column, and `-ml-1` cancelling its own `pl-1` so the favicon lands in the
 * status dot's column rather than the plan's. Both callers used to wrap it in a
 * row of their own, which left an empty row — and the column's gap — behind
 * whenever the chip had no tab to name.
 */
export function DrivenTabChip({ tab }: { tab?: TabChipTarget }) {
  const { t } = useTranslation();
  const liveTab = useConversationStore((s) => s.drivingTab);
  // Keyed on the url, not a boolean: a re-targeted tab gets a fresh icon try
  // without an effect to reset state.
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);

  // A title-less tab (a PDF, some file:// pages) still gets its row — the
  // hostname stands in, the same fallback TabStamp uses. Only no tab at all
  // drops the row.
  const drivingTab = tab ?? liveTab;
  // Destructured before the guard: TypeScript drops a narrowing on `obj.prop`
  // the moment it crosses into a callback, so reading tabId off the object in
  // onClick would need a `!` the guard has already earned.
  const { tabId, windowId, url, favIconUrl } = drivingTab ?? {};
  const label = drivingTab?.title || (drivingTab?.url ? hostnameOf(drivingTab.url) : "");
  // A url is enough: it outlives the tab, and reopening it is what the click
  // does anyway. Only a page with no name AND no address has nothing to offer.
  if (!label || (tabId === undefined && !url)) return null;

  return (
    <button
      type="button"
      onClick={() => void revealTab({ tabId, windowId, url })}
      title={t("run.drivingTabTip")}
      aria-label={t("run.drivingTabTip")}
      className="-ml-1 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 self-start rounded-full bg-brand-100/80 py-1 pr-2.5 pl-1 text-xs text-brand-900 hover:bg-brand-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:bg-brand-900/60 dark:text-brand-100 dark:hover:bg-brand-800"
    >
      {favIconUrl && favIconUrl !== failedIconUrl && (
        <img
          src={favIconUrl}
          alt=""
          className="h-3.5 w-3.5 shrink-0 rounded-[3px]"
          onError={() => setFailedIconUrl(favIconUrl)}
        />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
