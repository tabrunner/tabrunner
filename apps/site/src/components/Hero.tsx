import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { detectBrowser, type BrowserGuess } from "../lib/browser";
import { CHROMIUM_BROWSERS, LINKS } from "../lib/links";
import { launchComet } from "./CometField";
import { RunConsole } from "./RunConsole";

/**
 * First viewport: the thesis. A task goes into the mission line, a comet-tab
 * leaves it — and the console beside it shows what a run looks like. The
 * primary action (Download) sits under the pitch, glow and all, and names the
 * visitor's own browser when it can; a non-Chromium visitor gets the truth in
 * words instead of a button that would never work (the DESIGN.md rule).
 * It goes to the store listing — one click, and no file left in a folder with
 * no next step, which is why it no longer has to drag the page to #install.
 */
export function Hero() {
  const { t } = useTranslation();
  const placeholders = t("hero.placeholders", { returnObjects: true }) as string[];
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [launched, setLaunched] = useState(false);
  const [browser, setBrowser] = useState<BrowserGuess | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    void detectBrowser().then((b) => {
      if (live) setBrowser(b);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % placeholders.length);
    }, 3200);
    return () => clearInterval(id);
  }, [placeholders.length]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rect = formRef.current?.getBoundingClientRect();
    launchComet(
      rect ? { x: rect.left + rect.width * 0.75, y: rect.top + rect.height / 2 } : undefined,
    );
    setPlaceholderIndex((i) => (i + 1) % placeholders.length);
    setLaunched(true);
  };

  return (
    <section id="top" className="mx-auto max-w-6xl px-4 pt-16 pb-20 sm:px-6 lg:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(2.1rem,4.8vw,3.6rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
            <span className="block">{t("hero.titleA")}</span>
            <span className="block text-flare-400">{t("hero.titleB")}</span>
          </h1>
          <p className="mt-6 max-w-[62ch] text-lg leading-relaxed text-star-300">{t("hero.sub")}</p>

          {/* mission line — the product's own gesture: describe a task */}
          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="mt-8 flex items-center gap-2 rounded-2xl border border-field-500/70 bg-field-800/70 p-2 backdrop-blur-sm transition-colors focus-within:border-flare-500/60"
          >
            <label htmlFor="mission-line" className="sr-only">
              {t("hero.missionLabel")}
            </label>
            <input
              id="mission-line"
              type="text"
              placeholder={placeholders[placeholderIndex]}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-star-100 outline-none placeholder:text-star-500"
            />
            <button
              type="submit"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-field-600 px-4 py-2 font-mono text-sm text-flare-300 transition-colors hover:bg-field-500 hover:text-flare-200"
            >
              {t("hero.missionGo")}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-3.5"
                aria-hidden="true"
              >
                <path d="M7 17 17 7" />
                <path d="M8 7h9v9" />
              </svg>
            </button>
          </form>
          {/*
           * The mission line is a gesture, not a product surface — so once it
           * fires it says what just happened and points at the way to the real
           * thing, rather than swallowing the task silently.
           */}
          <p className="mt-3 max-w-[56ch] text-sm text-star-500" aria-live="polite">
            {launched ? (
              <>
                {t("hero.demoLaunched")}{" "}
                <a
                  href="#install"
                  className="font-semibold text-flare-300 underline decoration-flare-500/40 underline-offset-4 transition-colors hover:text-flare-200"
                >
                  {t("hero.ctaSecondary")}
                </a>
              </>
            ) : (
              t("hero.demoHint")
            )}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            {browser && !browser.chromium ? (
              <p className="max-w-md text-sm leading-relaxed text-star-300">
                {t("hero.ctaUnsupported")}
              </p>
            ) : (
              <a
                href={LINKS.store}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-flare-500 px-6 py-3 font-semibold text-field-950 shadow-[0_0_32px_-4px] shadow-flare-500/50 transition-all hover:bg-flare-400 hover:shadow-flare-400/60"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-4"
                  aria-hidden="true"
                >
                  <path d="M12 3v12" />
                  <path d="m7 11 5 5 5-5" />
                  <path d="M4 21h16" />
                </svg>
                {browser && browser.name !== "Chromium"
                  ? t("hero.ctaFor", { browser: browser.name })
                  : t("hero.ctaPrimary")}
              </a>
            )}
            <a
              href="#install"
              className="rounded-full border border-field-500 px-6 py-3 font-semibold text-star-100 transition-colors hover:border-flare-500/60 hover:text-flare-300"
            >
              {t("hero.ctaSecondary")}
            </a>
          </div>

          <div className="mt-10">
            <p className="font-mono text-xs tracking-wider text-star-500 uppercase">
              {t("hero.browsersLabel")}
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {CHROMIUM_BROWSERS.map((browser) => (
                <li
                  key={browser}
                  className="rounded-full border border-field-600/70 px-3 py-1 font-mono text-xs text-star-300"
                >
                  {browser}
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-[56ch] text-xs leading-relaxed text-star-500">
              {t("hero.chromiumNote")}
            </p>
          </div>
        </div>

        <div className="min-w-0">
          <RunConsole />
          <p className="mt-3 text-xs text-star-500">{t("run.stopNote")}</p>
        </div>
      </div>
    </section>
  );
}
