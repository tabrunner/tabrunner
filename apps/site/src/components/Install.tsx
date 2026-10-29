import { useTranslation } from "react-i18next";
import { LINKS } from "../lib/links";

/**
 * The flight plan — getting running as a launch sequence, caveats said plainly
 * beside it. Since the store listing went live the install itself is one click,
 * so the three stages cover what's actually left: add it, open the panel, point
 * it at a provider. The ZIP stays as the developer-mode path (same extension
 * ID, so it can't sit alongside the store build); no version numbers anywhere,
 * per the download contract in docs/website-brief.md.
 */
export function Install() {
  const { t } = useTranslation();
  const steps = t("install.steps", { returnObjects: true }) as string[];
  const caveats = t("install.caveats", { returnObjects: true }) as string[];

  return (
    <section id="install" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="max-w-[20ch] font-display text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
        {t("install.title")}
      </h2>
      <p className="mt-4 max-w-[62ch] text-lg leading-relaxed text-star-300">{t("install.sub")}</p>

      <div className="mt-12 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        {/* launch sequence */}
        <div className="flex h-full min-w-0 flex-col rounded-2xl border border-field-500/60 bg-field-800/60 p-6 backdrop-blur-sm sm:p-8">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-star-100">{t("install.storeTitle")}</h3>
            <span className="rounded-full bg-flare-500/15 px-2.5 py-0.5 font-mono text-[10px] tracking-wider text-flare-300 uppercase">
              {t("install.badge")}
            </span>
          </div>

          <ol className="mt-6 space-y-0">
            {steps.map((step, i) => (
              <li key={step} className="relative flex gap-4 pb-6 last:pb-0">
                {/* the trajectory line connecting stages */}
                {i < steps.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-8 left-[15px] h-[calc(100%-2rem)] w-px bg-gradient-to-b from-flare-500/60 to-flare-500/10"
                  />
                )}
                <span className="tnum z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-flare-500/50 bg-field-900 font-mono text-sm text-flare-300">
                  {i + 1}
                </span>
                <p className="pt-1.5 text-sm leading-relaxed text-star-300">{step}</p>
              </li>
            ))}
          </ol>

          <div className="mt-8 mb-8 flex flex-wrap items-center gap-3">
            <a
              href={LINKS.store}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-flare-500 px-6 py-3 font-semibold text-field-950 shadow-[0_0_32px_-4px] shadow-flare-500/50 transition-all hover:bg-flare-400 hover:shadow-flare-400/60"
            >
              {t("install.storeCta")}
            </a>
            <a
              href={LINKS.releases}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-field-500 px-5 py-3 text-sm font-semibold text-star-100 transition-colors hover:border-flare-500/60 hover:text-flare-300"
            >
              {t("install.releaseNotes")}
            </a>
          </div>

          {/* The self-hosted path stays reachable, one fold down — it's the
              minority route now, but the source build shouldn't need a hunt. */}
          {/* mt-auto keeps it on the card's floor when the caveats column runs
              taller; the buttons' mb-8 guarantees the gap when it doesn't. */}
          <details className="mt-auto rounded-xl border border-field-600/60 bg-field-900/50 open:border-field-500">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-star-100 transition-colors hover:text-flare-300">
              {t("install.zipTitle")}
            </summary>
            <div className="border-t border-field-600/60 px-4 py-3">
              <p className="text-sm leading-relaxed text-star-300">{t("install.zipSteps")}</p>
              <a
                href={LINKS.zip}
                className="mt-3 inline-block text-sm font-semibold text-flare-300 underline decoration-flare-500/40 underline-offset-4 hover:text-flare-200"
              >
                {t("install.downloadZip")}
              </a>

              {/* Updating is where this path quietly costs people their data: a
                  new ZIP unzips to a NEW folder, Chrome refuses the duplicate
                  id, and the obvious way out — Remove, then load again — takes
                  the storage with it. The steps and the one thing never to do
                  sit together, weighted by contrast alone: the Two Lights rule
                  means a warning gets no hue of its own. */}
              <div className="mt-5 border-t border-field-600/60 pt-4">
                <p className="font-mono text-[10px] tracking-wider text-star-500 uppercase">
                  {t("install.zipUpdateTitle")}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-star-300">
                  {t("install.zipUpdateBody")}
                </p>
                <p className="mt-2 text-sm leading-relaxed font-medium text-star-100">
                  {t("install.zipUpdateWarning")}
                </p>
              </div>
            </div>
          </details>
        </div>

        {/* caveats — said plainly */}
        <div className="h-full min-w-0 rounded-2xl border border-field-500/60 bg-field-800/40 p-6 sm:p-8">
          <h3 className="text-lg font-semibold text-star-100">{t("install.caveatsTitle")}</h3>
          <ul className="mt-5 space-y-4">
            {caveats.map((caveat) => (
              <li key={caveat} className="flex gap-3 text-sm leading-relaxed text-star-300">
                <span
                  aria-hidden="true"
                  className="mt-[7px] size-1.5 shrink-0 rotate-45 bg-flare-400"
                />
                {caveat}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
