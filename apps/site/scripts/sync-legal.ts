/**
 * Copy the root legal documents into each published language's src/legal/ file.
 * Read every source before writing so a missing translation leaves all copies intact.
 *
 *   bun run sync:legal
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { localeSegment } from "../src/config/locale";
import { legalSourceFile, PUBLIC_PAGES } from "../src/config/publicPages";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(siteRoot, "..", "..");
const outDir = join(siteRoot, "src", "legal");

const docs = PUBLIC_PAGES.flatMap((page) => {
  const { doc } = page;
  if (!doc) return [];
  return page.languages.map((language) => ({
    source: join(repoRoot, legalSourceFile(doc, language)),
    out: join(outDir, localeSegment(language), `${doc}.md`),
  }));
});

const loaded = await Promise.all(
  docs.map(async ({ source, out }) => ({ source, out, body: await Bun.file(source).text() })),
);

for (const { source, out, body } of loaded) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  console.log(`${relative(siteRoot, out)} <- ${relative(repoRoot, source)}`);
}
