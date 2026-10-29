import i18n, { type i18n as I18n } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import {
  DEFAULT_LANGUAGE,
  localePath,
  splitLocalePath,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../config/locale";
import { PUBLIC_PAGES } from "../config/publicPages";
import { enUS } from "./locales/en-US";
import { ptBR } from "./locales/pt-BR";
import { esES } from "./locales/es-ES";

export { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../config/locale";

const STORAGE_KEY = "tabrunner-site-lang";

const COMMON = {
  resources: {
    "en-US": { translation: enUS },
    "pt-BR": { translation: ptBR },
    "es-ES": { translation: esES },
  },
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
};

/**
 * A SEPARATE i18next instance, for the build.
 *
 * `createInstance` rather than the shared singleton below, because the prerender renders all three
 * languages inside one process: with one instance they race for a single `lng` and the last
 * `changeLanguage` wins for every page still rendering. The browser has exactly one language at a
 * time and keeps using the default export.
 */
export function createI18n(language: SupportedLanguage): I18n {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({ ...COMMON, lng: language });
  return instance;
}

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language the page being rendered is in, typed — for building links that stay in it.
 *
 * From the hook's instance, never this module's singleton: the build renders three languages in
 * one process through a provider, and the singleton is stuck on the default there.
 */
export function useLanguage(): SupportedLanguage {
  const { i18n: instance } = useTranslation();
  return isSupported(instance.language) ? instance.language : DEFAULT_LANGUAGE;
}

function normalize(tag: string): SupportedLanguage | null {
  const lower = tag.toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("es")) return "es-ES";
  if (lower.startsWith("en")) return "en-US";
  return null;
}

/**
 * What language this reader would probably want — used for ONE redirect off an unprefixed
 * address, and for nothing else.
 *
 * `?lang=` first (an explicit link beats a remembered choice), then the choice they last made
 * here, then the browser. This is the entire remains of the old detector: it can move the reader
 * to an address, but it can never change what an address MEANS.
 */
export function preferredLanguage(): SupportedLanguage {
  try {
    const param = new URLSearchParams(window.location.search).get("lang");
    const asked = param ? normalize(param) : null;
    if (asked) return asked;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    // private mode etc. — fall through to the browser's list
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const guess = normalize(tag);
    if (guess) return guess;
  }
  return DEFAULT_LANGUAGE;
}

/** Record a language the reader CHOSE, so the next bare `/` sends them back to it. Called by the
 *  switcher as it navigates — never on load, where it would mistake "typed the root once" for a
 *  decision and pin them to it forever. */
export function rememberLanguage(language: SupportedLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // non-fatal: the choice just won't persist
  }
}

/**
 * The browser's instance — and the language comes from the ADDRESS.
 *
 * `/pt` is Portuguese for everyone, forever. It used to be whatever the reader's browser
 * happened to say, which is a page that cannot be indexed (a crawler fetches an address once and
 * whatever it received is all that address will ever mean) and cannot be shared (the link you send
 * shows the other person a different page than the one you were reading).
 */
const initial: SupportedLanguage =
  typeof window === "undefined"
    ? DEFAULT_LANGUAGE
    : splitLocalePath(window.location.pathname).language;

void i18n.use(initReactI18next).init({ ...COMMON, lng: initial });

/**
 * The one hop the old detector is allowed to make: an unprefixed address may send a reader to
 * their own language, BEFORE the first render, and only there.
 *
 * A crawler never takes it (Googlebot asks for en-US and there is no stored choice), and a reader
 * who followed a link to `/pt` or `/es` is never moved off it. Returns the address to go to, or
 * null to stay — separated from the redirect itself so it can be reasoned about and checked.
 */
export function redirectTarget(pathname: string, search: string, hash: string): string | null {
  const here = splitLocalePath(pathname);
  if (here.language !== DEFAULT_LANGUAGE) return null;
  // `splitLocalePath` also answers "default" for an address that simply has no language segment,
  // which is exactly the case this exists for. An address that already carries `/en-us` cannot
  // occur — English has no segment at all.
  const wanted = preferredLanguage();
  if (wanted === DEFAULT_LANGUAGE) return null;
  // Only to a page that EXISTS in that language: a page published in fewer languages than the
  // registry supports would otherwise send the reader to a 404, and a redirect into nothing is
  // worse than the page they asked for.
  const page = PUBLIC_PAGES.find((p) => p.path === here.path);
  if (!page?.languages.includes(wanted)) return null;
  return `${localePath(wanted, here.path)}${search}${hash}`;
}

export default i18n;
