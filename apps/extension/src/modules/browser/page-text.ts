import { runInPage } from "./inject";
import { i18n } from "@/i18n";
import type { TabId } from "@/shared/types";

/**
 * The page as prose.
 *
 * The accessibility snapshot clamps every node's text at 100 characters —
 * exactly right for finding a button, useless for reading an article, a review
 * thread, or an email body. This is the other half of seeing a page: the text
 * as rendered, bounded and pageable, with no refs and no structure.
 */

/** One window of a page's text. */
export interface PageTextResult {
  text: string;
  url: string;
  title: string;
  /** Where this window starts, in characters — a follow-up call continues past it. */
  from: number;
  /** The page's whole length, so the model can tell there is more. */
  total: number;
}

/** Long enough for a full article, short enough not to spend a turn's budget. */
export const MAX_PAGE_TEXT = 20_000;

export async function capturePageText(
  tabId: TabId,
  from = 0,
  limit = MAX_PAGE_TEXT,
): Promise<PageTextResult> {
  const start = Number.isFinite(from) ? Math.max(0, Math.trunc(from)) : 0;
  const count = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_TEXT)
    : MAX_PAGE_TEXT;

  const result = await runInPage(
    tabId,
    (offset: number, take: number) => {
      // innerText, not textContent: it is what the page actually renders — no
      // script bodies, no display:none subtrees, and line breaks where the
      // layout puts them. The blank-line collapse is pure token savings; pages
      // that lay out with empty divs otherwise pay for hundreds of them.
      const whole = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
      return {
        text: whole.slice(offset, offset + take),
        url: location.href,
        title: document.title,
        total: whole.length,
      };
    },
    [start, count],
  );
  if (!result) throw new Error(i18n.t("errors.snapshotFailed"));
  return { ...result, from: start };
}
