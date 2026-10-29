import { useTranslation } from "react-i18next";
import { rememberLanguage } from "../i18n";
import { htmlLang, localePath, SUPPORTED_LANGUAGES } from "../config/locale";

/**
 * The language links for this page. They are LINKS, not a `changeLanguage` call. Switching in place
 * left the reader at an address that said English while showing Portuguese: the link they shared
 * showed the other person a different page, and a crawler could not reach two of the three
 * languages at all. These are also the only in-page links between the versions, which is how a
 * crawler learns they are one page rather than three thin competing ones.
 *
 * `roomy` is for the footer on phones, where a thumb has to hit it: 44 px tall instead of the
 * header's 26.
 */
export function LanguageSwitcher({ route, roomy = false }: { route: string; roomy?: boolean }) {
  // `i18n` from the hook, never the module's default instance: the build renders three languages
  // in one process through a provider, and the singleton is stuck on the default there.
  const { t, i18n } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t("nav.languageLabel")}
      className="inline-flex items-center rounded-full border border-field-600/70 p-0.5 font-mono text-[11px]"
    >
      {SUPPORTED_LANGUAGES.map((lng) => {
        const query = new URLSearchParams(
          typeof window === "undefined" ? "" : window.location.search,
        );
        query.set("lang", lng);
        const hash = typeof window === "undefined" ? "" : window.location.hash;
        return (
          <a
            key={lng}
            href={`${localePath(lng, route)}?${query}${hash}`}
            hrefLang={htmlLang(lng)}
            onClick={() => rememberLanguage(lng)}
            aria-current={i18n.language === lng ? "true" : undefined}
            title={i18n.getFixedT(lng)("langName")}
            className={`rounded-full transition-colors ${
              roomy ? "flex min-h-11 min-w-11 items-center justify-center px-3" : "px-2 py-1"
            } ${
              i18n.language === lng
                ? "bg-field-600 text-flare-300"
                : "text-star-500 hover:text-star-300"
            }`}
          >
            <span aria-hidden="true">{lng === "en-US" ? "EN" : lng === "pt-BR" ? "PT" : "ES"}</span>
            <span className="sr-only">{i18n.getFixedT(lng)("langName")}</span>
          </a>
        );
      })}
    </div>
  );
}
