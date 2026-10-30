import { useTranslation } from "react-i18next";
import { useLanguage } from "../i18n";
import { localePath } from "../config/locale";
import { LINKS } from "../lib/links";
import { CometMark } from "./CometMark";
import { GithubMark } from "./GithubMark";
import { LanguageSwitcher } from "./LanguageSwitcher";

/**
 * The page's own browser chrome: favicon + wordmark on the left, an omnibox
 * pill in the middle, and the actions a chrome bar would carry on the right —
 * including the one we want taken (the store CTA gets the glow; see DESIGN.md's
 * Glow-Means-Live rule: it's the primary action). It names the store rather
 * than the visitor's browser — the hero, which detects, does that naming.
 * GitHub sits with the actions, not the section anchors: it's an external
 * destination, and the icon keeps it visible on mobile, where the center
 * links collapse.
 *
 * It sits on the home page and on the pages that share its chrome (Docs). `route` is the address
 * without its language segment, passed in because the build renders every page where there is no
 * `window`. On the home page the section links scroll in place; anywhere else they lead to that
 * section of the home page, in the reader's language.
 */
export function Nav({ route }: { route: string }) {
  const { t } = useTranslation();
  const language = useLanguage();
  const onHome = route === "/";
  const home = localePath(language, "/");
  const section = (id: string) => (onHome ? `#${id}` : `${home}#${id}`);

  return (
    <header className="sticky top-0 z-20 border-b border-field-600/50 bg-field-900/80 backdrop-blur-md">
      <a
        href="#main"
        className="sr-only rounded-full bg-flare-500 px-4 py-2 font-semibold text-field-950 focus:not-sr-only focus:absolute focus:top-2 focus:left-4 focus:z-30"
      >
        {t("nav.skipToContent")}
      </a>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <a
          href={onHome ? "#top" : home}
          className="flex shrink-0 items-center gap-2.5 text-flare-400"
        >
          <CometMark size={26} />
          <span className="font-display text-sm font-semibold tracking-wide text-star-100">
            TabRunner
          </span>
        </a>

        {/* omnibox */}
        <div className="mx-auto hidden items-center gap-2 rounded-full border border-field-600/70 bg-field-800/80 px-4 py-1.5 md:flex">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="size-3.5 text-star-500"
            aria-hidden="true"
          >
            <rect x="5" y="10" width="14" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          <span className="font-mono text-xs text-star-500">
            tabrunner.app{onHome ? "" : localePath(language, route)}
          </span>
        </div>

        <nav
          aria-label={t("nav.sectionsLabel")}
          className="hidden items-center gap-6 text-sm text-star-300 md:flex"
        >
          <a href={section("features")} className="transition-colors hover:text-star-100">
            {t("nav.features")}
          </a>
          <a href={section("install")} className="transition-colors hover:text-star-100">
            {t("nav.install")}
          </a>
          <a href={section("privacy")} className="transition-colors hover:text-star-100">
            {t("nav.privacy")}
          </a>
          <a
            href={localePath(language, LINKS.docs)}
            aria-current={route === LINKS.docs ? "page" : undefined}
            className="transition-colors hover:text-star-100 aria-[current=page]:text-star-100"
          >
            {t("nav.docs")}
          </a>
        </nav>

        {/*
         * ml-auto pins the actions right on mobile, where the omnibox and links
         * are hidden and nothing else absorbs the free space. From md up the
         * omnibox's mx-auto takes over, so this margin stands down.
         */}
        <div className="ml-auto flex shrink-0 items-center gap-3 md:ml-0">
          {/*
           * Chrome-bar toolbar icon: borderless, color-only on hover — the
           * bordered pill is reserved for the Download CTA. Below sm the bar
           * is already full, so GitHub lives in the footer on phones instead of
           * overflowing the chrome.
           */}
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer"
            aria-label={t("nav.github")}
            title={t("nav.github")}
            className="hidden rounded-full p-1.5 text-star-500 transition-colors hover:text-star-100 sm:block"
          >
            <GithubMark size={16} />
          </a>
          {/*
           * Same reason as GitHub: wordmark, switcher and the store button do not fit a phone
           * (they need 423 px). Below sm the switcher moves to the footer, and the bar keeps the
           * one action we want taken.
           */}
          <div className="hidden sm:block">
            <LanguageSwitcher route={route} />
          </div>

          <a
            href={LINKS.store}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-flare-500 px-4 py-2 text-sm font-semibold text-field-950 shadow-[0_0_24px_-4px] shadow-flare-500/50 transition-all hover:bg-flare-400 hover:shadow-flare-400/60"
          >
            {t("nav.download")}
          </a>
        </div>
      </div>
    </header>
  );
}
