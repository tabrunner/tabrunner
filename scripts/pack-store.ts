/**
 * Packs the CWS upload from the build `bun run zip` already made — the store
 * zip is that folder minus the manifest `key`, so paying a second full compile
 * for one deleted JSON line was waste. Run it right after `bun run zip`: the
 * keyed build is the input, and its `key` presence is the check that the
 * folder really is that build.
 *
 * Why the field matters at all: the store derives the id from its own item
 * record and rejects uploads carrying a `key`, while every other channel
 * (site download, dev loads) needs it pinned — see wxt.config.ts.
 */
import { $ } from "bun";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { version } = await Bun.file("package.json").json<{ version: string }>();
if (!(await Bun.file("dist/chrome-mv3/manifest.json").exists())) {
  console.error("✗ No build to pack — run `bun run zip` first (it compiles and zips the keyed build).");
  process.exit(1);
}

// Stage a copy so the keyed build on disk stays untouched — it is the site's
// own artifact source, not a scratch dir.
const stage = `${tmpdir()}/tabrunner-store-${crypto.randomUUID()}`;
try {
  await $`mkdir -p ${stage}`;
  await $`cp -R dist/chrome-mv3/. ${stage}/`;
  const manifestPath = `${stage}/manifest.json`;
  const manifest = await Bun.file(manifestPath).json<Record<string, unknown>>();
  if (!("key" in manifest)) {
    console.error(
      "✗ dist/chrome-mv3 has no manifest key — not a keyed build. Run `bun run zip` for a fresh one.",
    );
    process.exit(1);
  }
  delete manifest.key;
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const out = `${process.cwd()}/dist/tabrunner-${version}-store.zip`;
  await $`rm -f ${out}`;
  await $`cd ${stage} && zip -rqX ${out} .`;
  console.log(`✔ dist/tabrunner-${version}-store.zip`);
} finally {
  await $`rm -rf ${stage}`;
}
