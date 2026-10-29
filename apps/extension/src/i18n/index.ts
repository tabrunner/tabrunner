import i18next from "i18next";
import { defineItem } from "@/lib/storage";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";
import es from "./locales/es.json";

export const SUPPORTED_LOCALES = ["en", "pt-BR", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
  es: "Español",
};

/** Stored override; null = follow the browser. */
export const localeItem = defineItem<Locale | null>("i18n:locale", null);

export function resolveLocale(stored: Locale | null): Locale {
  if (stored) return stored;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("pt")) return "pt-BR";
  if (nav.startsWith("es")) return "es";
  return DEFAULT_LOCALE;
}

/**
 * The one i18next instance for every context. Kept React-free so the service
 * worker can compose user-visible strings too — UI entrypoints attach
 * initReactI18next onto this same instance before init.
 */
export const i18n = i18next.createInstance();

/**
 * The active language's own name — "English", "Português (Brasil)". The model's
 * plan steps and done summary are rendered verbatim in the panel, so the system
 * prompt names the language outright instead of hoping the model guesses it.
 */
export function currentLanguageName(): string {
  const locale = SUPPORTED_LOCALES.find((l) => l === i18n.language) ?? DEFAULT_LOCALE;
  return LOCALE_LABELS[locale];
}

let started: Promise<unknown> | null = null;

/** Idempotent. Resolves once the catalogs are loaded and the storage watch is live. */
export function initI18n(): Promise<unknown> {
  started ??= (async () => {
    await i18n.init({
      resources: {
        en: { translation: en },
        "pt-BR": { translation: ptBR },
        es: { translation: es },
      },
      lng: resolveLocale(await localeItem.get()),
      fallbackLng: DEFAULT_LOCALE,
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
    localeItem.watch((stored) => void i18n.changeLanguage(resolveLocale(stored)));
  })();
  return started;
}
