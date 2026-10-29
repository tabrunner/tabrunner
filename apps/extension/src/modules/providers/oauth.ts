import { SignInError } from "@providerkit/core/auth";

/** An authorization code is only good for a few minutes — stop waiting past that. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** What the sign-in flows send as the app name: `TabRunner/<version>`. */
export const appName = (): string => `TabRunner/${chrome.runtime.getManifest().version}`;

/**
 * Close a tab we opened, tolerating one that is already gone. Every exit runs
 * the same cleanup, and a tab's lifetime is not ours to assume: the window can
 * close under it, or the browser can be shutting down. `tabs.remove` on a dead
 * id rejects with "No tab with id", so an unguarded call surfaces as an
 * uncaught rejection — noise from what is really a completed cancel.
 */
function closeTab(tabId?: number): void {
  if (tabId === undefined) return;
  void chrome.tabs.remove(tabId).catch(() => {});
}

/**
 * Open the approval page and wait for the browser to redirect it to our
 * localhost callback, then read the code off the URL. There's no server behind
 * that port — the tab is about to show a connection error — so the code is
 * grabbed the moment the navigation starts and the tab is closed before that
 * page renders. The tab is closed on every exit: success, failure, or cancel.
 */
export function captureRedirect(opts: {
  authorizeUrl: string;
  redirectUri: string;
  /**
   * The CSRF value we issued, when the vendor round-trips one. Omitted for a
   * vendor that takes no `state` at all (OpenRouter) — and safe to omit here
   * in a way it would not be on a server, because this callback is not a
   * public endpoint: the answer is only read off the ONE tab we opened, whose
   * id we hold, and PKCE still binds the code to a verifier that never left
   * this worker. A forged code would have to arrive inside our own tab and
   * would still fail the exchange.
   */
  state?: string;
  signal: AbortSignal;
}): Promise<string> {
  const { origin: callbackOrigin, pathname: callbackPath } = new URL(opts.redirectUri);
  const { authorizeUrl, state, signal } = opts;

  return new Promise((resolve, reject) => {
    let openedTabId: number | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      closeTab(openedTabId);
    };

    const onAbort = () => finish(() => reject(new SignInError("cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(
      () => finish(() => reject(new SignInError("expired"))),
      CALLBACK_TIMEOUT_MS,
    );

    // The installed @types/chrome is a partial stub without TabChangeInfo —
    // derive the listener signature from the API it attaches to instead.
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      tabId,
      changeInfo,
    ) => {
      if (tabId !== openedTabId || !changeInfo.url) return;
      // The approval page bounces vendor → consent → localhost callback; only
      // the final hop onto our redirect matters.
      if (!changeInfo.url.startsWith(callbackOrigin)) return;
      const url = new URL(changeInfo.url);
      if (url.pathname !== callbackPath) return;

      // CSRF guard: when we issued a state, the callback must carry it back.
      if (
        (state !== undefined && url.searchParams.get("state") !== state) ||
        url.searchParams.get("error")
      ) {
        finish(() => reject(new SignInError("denied")));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        finish(() => reject(new SignInError("denied")));
        return;
      }
      finish(() => resolve(code));
    };

    // The user closing the approve tab is a cancel, not a five-minute wait.
    // Forget the id first: the tab is already gone, so the cleanup that follows
    // must not ask Chrome to close it again.
    const onRemoved: Parameters<typeof chrome.tabs.onRemoved.addListener>[0] = (tabId) => {
      if (tabId !== openedTabId) return;
      openedTabId = undefined;
      finish(() => reject(new SignInError("cancelled")));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    void chrome.tabs.create({ url: authorizeUrl }).then(
      (tab) => {
        if (settled) {
          // The tab created is ours, so its id is set — but the type keeps it
          // optional, and removing an id-less tab would be a no-op anyway.
          closeTab(tab.id);
          return;
        }
        openedTabId = tab.id;
      },
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}
