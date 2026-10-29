/**
 * Where each language lives in the URL.
 *
 * The family's frozen signatures (`localeSegment`, `localePrefix`, `localePath`, `splitLocalePath`,
 * `ogLocale`, `htmlLang`) — same names and same behaviour as aboard, featury and whatsapi, so
 * anyone who has read one has read all of them.
 *
 * Why this exists: one address serving three languages by sniffing `navigator` cannot be indexed.
 * A crawler fetches it once, and whichever language it happened to receive is the only thing that
 * address will ever mean — so two of the three were unreachable, and a `?lang=` link was the only
 * shareable form of a page that should have had three addresses.
 */
export const SUPPORTED_LANGUAGES = ["en-US", "pt-BR", "es-ES"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SupportedLanguage = "en-US";

/**
 * The URL segment for a language: `""` for English, `"pt"`, `"es"`.
 *
 * English is UNPREFIXED and the others carry their segment. Asymmetric on purpose: every address
 * tabrunner.app has published stays valid, and the bare root needs no redirect — the one thing a
 * crawler handles worst, and what `x-default` points at, so it has to be a real page.
 *
 * The segment is the BASE subtag, so `pt-BR` lives at `/pt` and `es-ES` at `/es`. The region
 * belongs to the `hreflang` TAG, which has to be real BCP-47; an address does not, and it is the
 * thing people type, paste, shorten and read aloud. (`/pt-br` until Sep 6 2026 — the published
 * addresses 301 in `public/_redirects`, and the pair ships together or the change is a hole in
 * the index.)
 *
 * ponytail: two variants of ONE base language collide here — `pt-BR` and `pt-PT` would both want
 * `/pt`. That is the wall to hit before rethinking this, and the upgrade path is a per-language
 * segment map, which is exactly what the region form was.
 *
 * LOWERCASE, always: paths are case-sensitive and get lowercased by half the tools that touch a
 * link, while only the tag has to be real BCP-47.
 */
export function localeSegment(language: SupportedLanguage): string {
  return language === DEFAULT_LANGUAGE ? "" : language.replace(/-.*$/, "").toLowerCase();
}

/** `""` for English, `/pt`, `/es`. */
export function localePrefix(language: SupportedLanguage): string {
  const segment = localeSegment(language);
  return segment === "" ? "" : `/${segment}`;
}

/** A route path in one language. The root stays a bare `/` in English and `/pt` (no trailing
 *  slash) elsewhere. */
export function localePath(language: SupportedLanguage, path: string): string {
  const prefix = localePrefix(language);
  if (path === "/") return prefix === "" ? "/" : prefix;
  return `${prefix}${path}`;
}

/**
 * The inverse: which language an address is for, and the route path under it.
 *
 * Matched against the SEGMENT, never the tag — comparing a pathname to `SUPPORTED_LANGUAGES` by
 * string equality is how `/pt` fails to match `pt-BR` and gets debugged at 2am. An unprefixed or
 * unrecognized path belongs to the default language, so `/fr` reads as an English page called
 * `/fr` (a 404) rather than silently becoming the home page — and so does the retired `/pt-br`,
 * which is a 301 at the edge, never a second spelling this resolves.
 */
export function splitLocalePath(pathname: string): {
  language: SupportedLanguage;
  path: string;
} {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const segment = match?.[1]?.toLowerCase();
  const found = SUPPORTED_LANGUAGES.find(
    (language) => language !== DEFAULT_LANGUAGE && localeSegment(language) === segment,
  );
  if (match && found) return { language: found, path: routePath(match[2] ?? "/") };
  return { language: DEFAULT_LANGUAGE, path: routePath(pathname) };
}

/** One spelling per route. `/privacy/` and `/privacy` are the same page — Pages serves both from
 *  the same flat file — and the App matched them with an `||` before this existed. */
function routePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** The BCP-47 tag a page ANNOUNCES itself with — `<html lang>` and `hreflang`. Already exact
 *  here, and the identity mapping is the point: the tag is the catalog's own name. */
export function htmlLang(language: SupportedLanguage): string {
  return language;
}

/** The underscored form `og:locale` expects. One home for the mapping, so a page rendered in
 *  Spanish never ships a card claiming `en_US` — which the single shared shell did. */
export function ogLocale(language: SupportedLanguage): string {
  return language.replace("-", "_");
}
