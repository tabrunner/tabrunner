/**
 * Write the site as files — one per page per language, plus a 404 shell per language, the sitemap
 * and robots.txt.
 *
 * Runs after BOTH vite builds: the client build bakes the asset tags into `dist/index.html`, and
 * the SSR build compiles the same app for this process to render. See `src/config/prerender.ts`
 * for what goes in each head and why the files are flat.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSitemap, type PrerenderedPage, prerenderPage } from "../src/config/prerender";
import {
  DEFAULT_LANGUAGE,
  htmlLang,
  localePath,
  localeSegment,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../src/config/locale";
import { type LegalDoc, PUBLIC_PAGES, SHELL_ROUTE } from "../src/config/publicPages";
import { enUS } from "../src/i18n/locales/en-US";
import { ptBR } from "../src/i18n/locales/pt-BR";
import { esES } from "../src/i18n/locales/es-ES";
import { discoveryFiles, softwareJsonLd } from "../src/config/discovery";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");

const CATALOGS: Record<SupportedLanguage, typeof enUS> = {
  "en-US": enUS,
  "pt-BR": ptBR,
  "es-ES": esES,
};

/** Resolve a dotted catalog key; throws rather than falling back to the key, because a head
 *  reading "seo.title" is worse than a build that stopped. */
function resolve(language: SupportedLanguage, key: string): string {
  let node: unknown = CATALOGS[language];
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in node) {
      node = (node as Record<string, unknown>)[part];
    } else {
      throw new Error(`prerender: ${language} catalog has no key "${key}"`);
    }
  }
  if (typeof node !== "string") throw new Error(`prerender: ${language} "${key}" is not a string`);
  return node;
}

/** The bold label every version of a legal doc opens its summary with: "**The short version:**",
 *  "**Em resumo:**", "**En resumen:**". */
const SUMMARY_LABEL = /^\*\*[^*]+:\*\*\s*/;

/**
 * A legal page's head, taken from the document it renders, in the language it renders.
 *
 * The docs are synced from the extension repo (`bun run sync:legal`), so their own H1 and opening
 * sentence are the only version of this copy that cannot drift from what the page actually says.
 */
function docHead(
  doc: LegalDoc,
  language: SupportedLanguage,
): { title: string; description: string } {
  const file = path.join(root, "src/legal", localeSegment(language), `${doc}.md`);
  const md = readFileSync(file, "utf8");
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
  // Each doc opens with a bold-labelled summary paragraph written to be exactly this — the whole
  // document in three sentences. The `_Last updated…_` line above it is metadata, not a
  // description, and it is what a naive "first paragraph" picks.
  const summary = md
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .find((block) => SUMMARY_LABEL.test(block));
  if (!title || !summary)
    throw new Error(`prerender: ${file} has no heading or no bold-labelled summary paragraph`);

  const description = summary
    .replace(SUMMARY_LABEL, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Portuguese rightly goes lowercase after the label ("o TabRunner é…"); a description stands on
    // its own, so it starts with a capital.
    .replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
  return {
    // The docs title themselves "TabRunner Privacy Policy"; appending the brand again reads as a
    // stutter in a tab and in a search result.
    title: title.includes("TabRunner") ? title : `${title} | TabRunner`,
    description: clamp(description, 300),
  };
}

/** Cut at a word boundary — "the websites y…" reads as a bug in a search result, which is the one
 *  place this string is ever seen. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:—-]$/, "")}…`;
}

/**
 * What a build-time gate CAN prove, on the bytes actually written.
 *
 * Every failure this catches has shipped green somewhere in this family: an empty root under a
 * perfect head, a Suspense fallback rendered as the whole page, a language that announced itself
 * as another one. The size floor is the one that catches a render that "worked" and produced
 * nothing at all.
 */
function assertRendered(file: string, html: string, language: SupportedLanguage): void {
  const fail = (why: string): never => {
    throw new Error(`prerender: ${file} ${why}`);
  };

  if (!html.includes(`<html lang="${htmlLang(language)}"`))
    fail(`does not announce lang="${htmlLang(language)}"`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail("has an empty title");

  const opened = /<div id="root"[^>]*>/.exec(html);
  if (!opened) fail("has no root element at all");
  const at = (opened?.index ?? 0) + (opened?.[0].length ?? 0);
  if (!/^<[a-z]/.test(html.slice(at, at + 200).trimStart()))
    fail("has no element inside its root. The page did not render");
  // Far below any real page here and far above an empty shell or a spinner. It is the only check
  // that fires when a render succeeds and produces almost nothing.
  if (html.length < 8_000) fail(`is only ${html.length} bytes. That is not the page`);
}

/** Every hashed asset the markup points at has to be in `dist`. The SSR build resolves asset
 *  imports on its own, so a mismatch with the client build is a page of broken images that no
 *  other check here would see. */
function assertAssets(html: string, emitted: Set<string>): void {
  for (const ref of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    const asset = ref[1]?.replace(/^\//, "");
    if (asset && !emitted.has(asset))
      throw new Error(`prerender: markup points at ${asset}, which this build did not emit`);
  }
}

const template = readFileSync(path.join(dist, "index.html"), "utf8");

/**
 * The origin, read out of the BUILT template rather than kept in a second place.
 *
 * Whatever `index.html`'s canonical says the site is, is what every canonical, hreflang link and
 * sitemap entry says. A separate constant here is how a sitemap ends up advertising `localhost`.
 */
const origin = ((): string => {
  const found = /<link rel="canonical" href="([^"]*)"/.exec(template)?.[1]?.replace(/\/$/, "");
  if (!found || !/^https?:\/\//.test(found))
    throw new Error(`prerender: index.html's canonical is ${String(found)}, not an absolute URL`);
  return found;
})();

const { renderPage } = (await import(path.join(root, "dist-ssr/entry-server.js"))) as {
  renderPage: (language: SupportedLanguage, route: string) => Promise<string>;
};

const emitted = new Set(new Bun.Glob("assets/**").scanSync({ cwd: dist }));

const written: PrerenderedPage[] = [];

for (const page of PUBLIC_PAGES) {
  for (const language of page.languages) {
    const head = page.doc ? docHead(page.doc, language) : null;
    const rendered = await renderPage(language, page.path);
    assertAssets(rendered, emitted);
    const out = prerenderPage({
      template,
      page,
      language,
      siteUrl: origin,
      title: head ? head.title : resolve(language, page.titleKey ?? "seo.title"),
      description: head
        ? head.description
        : resolve(language, page.descriptionKey ?? "seo.description"),
      body: { route: localePath(language, page.path), html: rendered },
    });
    // The software is described on the pages about it: the front door and the guide.
    if (page.path === "/" || page.path === "/docs") {
      out.html = out.html.replace(
        "</head>",
        `${softwareJsonLd(origin, language, CATALOGS[language])}\n</head>`,
      );
    }
    assertRendered(out.file, out.html, language);
    written.push(out);
  }
}

/**
 * A 404 per language, because Pages can serve one (see `public/_redirects`).
 *
 * Each is `noindex`, carries no canonical and names the catch-all route rather than a real one, so
 * `main.tsx` mounts fresh over it instead of hydrating a page that isn't there. The catch-all
 * rewrite this replaces answered every typo on the domain with 200 and the home page — a soft 404,
 * which is a page a search engine indexes as content.
 */
const home = PUBLIC_PAGES[0];
if (!home) throw new Error("prerender: no public pages registered");
for (const language of SUPPORTED_LANGUAGES) {
  const out = prerenderPage({
    template,
    page: home,
    language,
    siteUrl: origin,
    title: `${resolve(language, "notFound.title")} | TabRunner`,
    description: resolve(language, "notFound.body"),
    body: { route: SHELL_ROUTE, html: await renderPage(language, "/") },
    shell: true,
  });
  assertRendered("404", out.html, language);
  const prefix = localePath(language, "/");
  written.push({
    file: prefix === "/" ? "404.html" : `${prefix.replace(/^\//, "")}/404.html`,
    html: out.html,
  });
}

for (const { file, html } of written) {
  const target = path.join(dist, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
}

writeFileSync(path.join(dist, "sitemap.xml"), buildSitemap(origin));
for (const [file, content] of Object.entries(discoveryFiles(origin))) {
  const target = path.join(dist, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
writeFileSync(
  path.join(dist, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
);

const addresses = PUBLIC_PAGES.reduce((n, page) => n + page.languages.length, 0);
console.log(
  `· prerendered ${written.length} files (${addresses} addresses + ` +
    `${SUPPORTED_LANGUAGES.length} 404 shells) + sitemap.xml + robots.txt`,
);

// The rendered page leaves timers and animation callbacks behind (the comet field, the run
// console), and a build must not wait on a landing page's idle work. Everything above is written
// synchronously, so nothing is in flight.
process.exit(0);
