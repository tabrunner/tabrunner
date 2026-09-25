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
 */
addEventListener("load", () => setTimeout(() => void import("./main")), { once: true });
