import { i18n } from "@/i18n";
import { isRestrictedPageError } from "./restricted-url";
import type { TabId } from "@/shared/types";

/** A JPEG of a visible tab, with the identity of what was actually captured. */
export interface VisibleCapture {
  /** `data:image/jpeg;base64,…` — images are data URLs everywhere inside TabRunner. */
  dataUrl: string;
  tabId: TabId;
  title: string;
  url: string;
}

/**
 * What the browser is showing right now, as an image an external model can
 * read. Uses `chrome.tabs`, not CDP: no debugger attach, so an idle browser can
 * be looked at without announcing a run — and it works when no run is in flight
 * at all, which is exactly when an MCP client wants to look.
 *
 * ponytail: captureVisibleTab captures a window's *visible* tab, so a tab
 * behind another, or in a window nobody can see, cannot be read this way. The
 * captured tab's own id/title/url ride along, so the caller can tell what it is
 * looking at and is never misled. While a run or a direct session holds the
 * debugger, the bridge reads that tab through CDP instead (bridge.ts), which
 * sees hidden tabs too; this path is what is left for an idle browser.
 */
export async function captureVisibleTab(windowId?: number): Promise<VisibleCapture> {
  const [tab] = await chrome.tabs.query(
    windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId },
  );
  if (!tab?.id || tab.windowId === undefined) throw new Error(i18n.t("errors.noActiveTab"));
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 80,
    });
    return { dataUrl, tabId: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // chrome:// and Web Store pages refuse capture the same way they refuse
    // scripting. Any other refusal (a minimized or covered window, a closed
    // tab) is its own failure: calling it a restricted page sends the person
    // looking for a problem that is not there.
    throw new Error(
      isRestrictedPageError(message)
        ? i18n.t("errors.restrictedPage")
        : i18n.t("errors.captureFailed", { message }),
      { cause: e },
    );
  }
}
