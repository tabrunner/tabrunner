/**
 * The side panel's first load — and nothing else may join it.
 *
 * Chromium keeps an extension's side panel hidden from the moment it is attached
 * until the document's first load finishes (`ExtensionViewViews::OnLoaded`), and a
 * load waits for every module script the page names. When this page named the
 * app directly, the panel stayed hidden for as long as React, Base UI and the
 * catalogs took to fetch and evaluate — and a hidden renderer runs at background
 * priority, so on a busy machine that was minutes of the browser's empty gray,
 * with the boot cover never drawn once.
 *
 * So this file imports nothing (ESLint holds the line). Its load finishes on the
 * static cover in index.html, the browser shows the panel, and the app starts
 * one task later — visible, at foreground priority, under a cover already on
 * screen. The extra task keeps the import from ever counting toward the load.
 *
 * It also owns what the cover says while the app is not there yet. A normal
 * open lifts the cover long before the first word, so the words are only for
 * the opens that need them.
 */

/** Past this, a silent mark stops reading as "starting". */
const SLOW_MS = 4_000;
/** Past this, something is wrong — offer the way out. */
const STUCK_MS = 15_000;

type BootState = "slow" | "stuck" | "failed";

/**
 * [message, hint] per state, as extension messages (public/_locales): the app's
 * own catalogs are exactly what has not loaded yet. They follow the browser's
 * language, not the in-app override — that setting lives in the app too.
 */
const COPY: Record<BootState, [string, string]> = {
  slow: ["bootSlow", ""],
  stuck: ["bootStuck", "bootStuckHint"],
  failed: ["bootFailed", "bootFailedHint"],
};

function say(state: BootState): void {
  const boot = document.getElementById("boot");
  // The app lifted the cover, so it is on screen with nothing left to explain.
  // A failure outranks the timers that fire after it.
  if (!boot || boot.classList.contains("done") || boot.dataset.state === "failed") return;
  boot.dataset.state = state;
  const [message, hint] = COPY[state];
  setText("boot-message", message);
  setText("boot-hint", hint);
  const retry = document.getElementById("boot-retry");
  if (!retry || state === "slow") return;
  retry.textContent = chrome.i18n.getMessage("bootRetry");
  retry.hidden = false;
  if (state === "failed") retry.focus();
}

function setText(id: string, key: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = key ? chrome.i18n.getMessage(key) : "";
}

// A reload starts the panel over. Runs live in the worker, so nothing the user
// started stops with it.
document.getElementById("boot-retry")?.addEventListener("click", () => location.reload());
setTimeout(() => say("slow"), SLOW_MS);
setTimeout(() => say("stuck"), STUCK_MS);
addEventListener(
  "load",
  () =>
    setTimeout(() =>
      import("./main").catch((e: unknown) => {
        say("failed");
        reportError(e);
      }),
    ),
  { once: true },
);
