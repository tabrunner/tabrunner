import type { TabId } from "@/shared/types";
import { i18n } from "@/i18n";
import { isRestrictedPageError } from "./restricted-url";

/**
 * Run a self-contained function in the page's MAIN world and return its result.
 * The one executeScript call site for page work (snapshot, ref resolve, fill),
 * so the error mapping lives once: a mid-navigation rejection is transient
 * (worded as retry), a restricted page is a hard stop. The injected function
 * must not close over module scope — it is serialized via toString().
 */
export async function runInPage<Args extends unknown[], R>(
  tabId: TabId,
  func: (...args: Args) => R,
  args: Args,
): Promise<R | undefined> {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      world: "MAIN",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/frame was removed|No frame with id|tab was closed/i.test(msg)) {
      throw new Error(i18n.t("errors.pageNavigating"), { cause: e });
    }
    if (isRestrictedPageError(msg)) {
      throw new Error(i18n.t("errors.restrictedPage"), { cause: e });
    }
    throw e;
  }
  return result?.result as R | undefined;
}
