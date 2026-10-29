import { useTranslation } from "react-i18next";
import { localePath } from "../config/locale";
import { useLanguage } from "../i18n";
import { LINKS } from "../lib/links";
import { CometMark } from "./CometMark";

/** A hairline that points: the map has to say which way the data moves. */
function Flow() {
  return (
    <div className="flex items-center" aria-hidden="true">
      <span className="h-px w-8 bg-flare-500/60 sm:w-14" />
      <svg
        viewBox="0 0 8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="-ml-px size-2 text-flare-500/70"
      >
        <path d="m3 1.5 3 2.5-3 2.5" />
      </svg>
    </div>
  );
}

/**
 * No ground station — the data-flow answer, up front. A simple map: the
 * browser talks to your provider and your sites; the TabRunner server node
 * is there only to be crossed out.
 */
export function Privacy() {
  const { t } = useTranslation();
  const language = useLanguage();
  const points = t("privacy.points", { returnObjects: true }) as string[];

  return (
    <section id="privacy" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 className="max-w-[20ch] font-display text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
            {t("privacy.title")}
          </h2>
          <p className="mt-4 max-w-[56ch] text-lg leading-relaxed text-star-300">
            {t("privacy.sub")}
          </p>
          <ul className="mt-8 space-y-4">
            {points.map((point) => (
              <li key={point} className="flex gap-3 leading-relaxed text-star-300">
                <span
                  aria-hidden="true"
                  className="mt-2.5 size-1.5 shrink-0 rotate-45 bg-flare-400"
                />
                {point}
              </li>
            ))}
          </ul>
          <a
            href={localePath(language, LINKS.privacy)}
            className="mt-8 inline-flex items-center gap-2 font-semibold text-flare-300 underline decoration-flare-500/40 underline-offset-4 transition-colors hover:text-flare-200"
          >
            {t("privacy.link")}
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
              <path d="M7 17 17 7" />
              <path d="M8 7h9v9" />
            </svg>
          </a>
        </div>

        {/* the data map */}
        <div
          className="min-w-0 rounded-2xl border border-field-500/60 bg-field-800/60 p-6 backdrop-blur-sm sm:p-8"
          role="img"
          aria-label={`${t("privacy.diagramBrowser")} → ${t("privacy.diagramProvider")}, ${t("privacy.diagramSites")}. ${t("privacy.diagramServer")}: ${t("privacy.diagramServerNone")}.`}
        >
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-3 gap-y-8">
            {/* browser node */}
            <div className="row-span-2 rounded-xl border border-flare-500/50 bg-field-900 px-4 py-5 text-center">
              <CometMark size={28} className="mx-auto" />
              <p className="mt-2 text-sm font-semibold text-star-100">
                {t("privacy.diagramBrowser")}
              </p>
            </div>

            {/* flows */}
            <Flow />
            <div className="rounded-xl border border-field-500/60 bg-field-900 px-4 py-4 text-center">
              <p className="text-sm font-semibold text-star-100">{t("privacy.diagramProvider")}</p>
              <p className="mt-1 font-mono text-[11px] text-flare-300">
                {t("privacy.diagramKeyFlow")}
              </p>
            </div>

            <Flow />
            <div className="rounded-xl border border-field-500/60 bg-field-900 px-4 py-4 text-center">
              <p className="text-sm font-semibold text-star-100">{t("privacy.diagramSites")}</p>
              <p className="mt-1 font-mono text-[11px] text-flare-300">
                {t("privacy.diagramTaskFlow")}
              </p>
            </div>

            {/* the server that isn't */}
            <div className="col-span-3 mx-auto rounded-xl border border-dashed border-field-500/70 px-6 py-3 text-center">
              <p className="font-mono text-xs text-star-500">
                <s>{t("privacy.diagramServer")}</s>: {t("privacy.diagramServerNone")}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
