/**
 * Build-time prerender — a real file per page per language, with the page in it.
 *
 * What this replaces: ONE `index.html`, announcing `lang="en"` and a single English head, served
 * at every address behind `/* /index.html 200`. Three things followed, none visible in a browser.
 *
 * The Portuguese and Spanish copy had no ADDRESS — the language was sniffed from `navigator` and
 * kept in localStorage, so a crawler fetched the one address once and English is all it ever
 * meant. `?lang=pt-BR` was a shareable link to a page search engines could not index as
 * Portuguese.
 *
 * The page had no BODY: everything a reader sees arrives by JavaScript, so to anything that reads
 * a link the site was a description tag.
 *
 * And every typo on the domain answered 200 with the home page — a soft 404, which is a page a
 * search engine indexes as content.
 */
import { DEFAULT_LANGUAGE, htmlLang, localePath, ogLocale, type SupportedLanguage } from "./locale";
import { PRERENDERED_ROUTE_ATTR, type PublicPage, PUBLIC_PAGES } from "./publicPages";

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace the `content` of one `<meta …>`. Throws when the tag is missing, so an edit to
 *  index.html fails the build instead of silently shipping the English meta on every language.
 *  `[\s\S]` because the attributes are split across lines in that file. */
function setMeta(html: string, selector: string, value: string): string {
  const re = new RegExp(`(<meta[\\s\\S]*?${escapeRegex(selector)}[\\s\\S]*?content=")[^"]*(")`);
  if (!re.test(html)) throw new Error(`prerender: <meta ${selector}> not found in index.html`);
  return html.replace(re, `$1${escapeAttr(value)}$2`);
}

export interface PrerenderedPage {
  file: string;
  html: string;
}

export interface PrerenderInput {
  template: string;
  page: PublicPage;
  language: SupportedLanguage;
  siteUrl: string;
  title: string;
  description: string;
  body?: { route: string; html: string };
  shell?: boolean;
}

/**
 * The `<link rel="alternate">` set for one page.
 *
 * RECIPROCAL and complete: every language the page is PUBLISHED in lists every other and itself,
 * plus an `x-default` pointing at the unprefixed English address. A one-way or partial set is
 * worse than none — a crawler that cannot confirm the link back ignores the whole cluster, so the
 * pages compete with each other instead of consolidating. A page published in one language gets
 * no cluster at all, which is the honest signal for the English-only legal docs.
 */
function alternates(page: PublicPage, siteUrl: string): string {
  if (page.languages.length < 2) return "";
  const links = page.languages.map(
    (l) =>
      `    <link rel="alternate" hreflang="${htmlLang(l)}" href="${siteUrl}${localePath(l, page.path)}" />`,
  );
  links.push(
    `    <link rel="alternate" hreflang="x-default" href="${siteUrl}${localePath(DEFAULT_LANGUAGE, page.path)}" />`,
  );
  return `${links.join("\n")}\n`;
}

/** Bake one page, in one language, into the built index.html. */
export function prerenderPage({
  template,
  page,
  language,
  siteUrl,
  title,
  description,
  body,
  shell = false,
}: PrerenderInput): PrerenderedPage {
  const canonical = `${siteUrl}${localePath(language, page.path)}`;

  // The one attribute that decides what language a crawler thinks this document is in. It was a
  // hardcoded `en` on the single shell every address shared, corrected at runtime by JavaScript —
  // which is to say, corrected for readers and for nobody else.
  let html = template.replace(/<html lang="[^"]*"/, `<html lang="${htmlLang(language)}"`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)}</title>`);
  html = setMeta(html, 'name="description"', description);
  html = setMeta(html, 'property="og:title"', title);
  html = setMeta(html, 'property="og:description"', description);

  if (shell) {
    // A 404 must never describe the front door: no canonical (an empty one is a claim about ""),
    // no share URL, and noindex.
    html = html
      .replace(/\s*<link rel="canonical"[^>]*>/, "")
      .replace(/\s*<meta property="og:url"[\s\S]*?content="[^"]*"[^>]*>/, "")
      .replace("</head>", '  <meta name="robots" content="noindex" />\n  </head>');
  } else {
    html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${escapeAttr(canonical)}$2`);
    html = setMeta(html, 'property="og:url"', canonical);
    html = html.replace(
      "</head>",
      `${alternates(page, siteUrl)}    <meta property="og:locale" content="${ogLocale(language)}" />\n  </head>`,
    );
  }

  if (body) {
    // Empty on purpose in the template, and it must STAY empty there: a second bake over an
    // already-filled root would nest one render inside another.
    const root = '<div id="root"></div>';
    if (!html.includes(root)) throw new Error(`prerender: ${root} not found in index.html`);
    html = html.replace(
      root,
      `<div id="root" ${PRERENDERED_ROUTE_ATTR}="${escapeAttr(body.route)}">${body.html}</div>`,
    );
  }

  return { file: pageFile(language, page.path), html };
}

/**
 * Where a rendered page lands.
 *
 * FLAT — `pt.html`, `privacy.html`, `pt/privacy.html` — never `privacy/index.html`.
 * Cloudflare Pages serves a directory index at `/privacy/` and answers `/privacy` with a 308, so
 * the directory form would make every canonical and every sitemap entry on this site a redirect
 * to the page rather than the page. A flat file answers 200 at both.
 */
export function pageFile(language: SupportedLanguage, routePath: string): string {
  const path = localePath(language, routePath);
  return path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`;
}

/** Emit `sitemap.xml` from the same registry — every page in every language it is published in. */
export function buildSitemap(siteUrl: string): string {
  const urls = PUBLIC_PAGES.flatMap((page) =>
    page.languages.map(
      (language) =>
        `  <url>\n` +
        `    <loc>${siteUrl}${localePath(language, page.path)}</loc>\n` +
        `    <changefreq>${page.changeFrequency}</changefreq>\n` +
        `    <priority>${page.priority.toFixed(1)}</priority>\n` +
        `  </url>`,
    ),
  ).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`
  );
}
