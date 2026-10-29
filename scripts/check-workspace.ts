import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import rootPackage from "../package.json";
import turbo from "../turbo.json";
import extension from "../apps/extension/package.json";
import site from "../apps/site/package.json";
import mcp from "../packages/mcp/package.json";
import registry from "../packages/mcp/server.json";
import marketplace from "../.claude-plugin/marketplace.json";
import claudePlugin from "../plugin/.claude-plugin/plugin.json";
import plugin from "../plugin/plugin.json";
import localMcp from "../.mcp.json";
import claudeLauncher from "../plugin/.mcp.json";
import launcher from "../plugin/mcp.json";
import { PUBLIC_PAGES, legalSourceFile } from "../apps/site/src/config/publicPages";
import { localeSegment } from "../apps/site/src/config/locale";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

assert.deepEqual(rootPackage.workspaces.packages, ["apps/*", "packages/*"]);
assert.equal(rootPackage.packageManager, "bun@1.4.2");
assert.equal(extension.name, "tabrunner", "WXT uses the package name in the release ZIP filename.");
assert.equal(site.name, "tabrunner-site");
assert.equal(mcp.name, "tabrunner-mcp");
assert.equal(mcp.bin["tabrunner-mcp"], "dist/tabrunner-mcp.js");
assert.equal(mcp.repository.directory, "packages/mcp");
assert.equal(registry.repository.subfolder, "packages/mcp");

for (const manifest of [mcp, registry, claudePlugin, plugin, ...registry.packages]) {
  assert.equal(manifest.version, extension.version, "Release versions must move together.");
}
for (const config of [claudeLauncher, launcher]) {
  assert.equal(config.mcpServers.tabrunner.command, "bunx");
  assert.deepEqual(config.mcpServers.tabrunner.args, [`tabrunner-mcp@${extension.version}`]);
}
assert.deepEqual(localMcp.mcpServers.tabrunner.args, ["packages/mcp/src/index.ts"]);
assert.equal(marketplace.plugins[0]?.source, "./plugin");
for (const path of [".claude/skills/tabrunner/SKILL.md", ".agents/skills/tabrunner/SKILL.md"]) {
  assert.equal(
    realpathSync(resolve(root, path)),
    resolve(root, "plugin/skills/tabrunner/SKILL.md"),
  );
}

for (const path of [
  "apps/extension/wxt.config.ts",
  "apps/site/vite.config.ts",
  "packages/mcp/src/index.ts",
  "docs/mcp.md",
  "docs/screenshots/01-side-panel.png",
]) {
  assert.ok(existsSync(resolve(root, path)), `Missing workspace input: ${path}`);
}
for (const page of PUBLIC_PAGES) {
  const { doc } = page;
  if (!doc) continue;
  for (const language of page.languages) {
    const source = legalSourceFile(doc, language);
    const copy = resolve(root, "apps/site/src/legal", localeSegment(language), `${doc}.md`);
    assert.equal(read(copy), read(source), `Run bun run --cwd apps/site sync:legal: ${copy}`);
  }
}

assert.ok(turbo.tasks.typecheck.dependsOn.includes("//#typecheck:tooling"));
assert.ok(turbo.tasks.build.env.includes("VITE_*"));
for (const path of ["scripts/release.ts", "scripts/build-daemon.ts"]) {
  assert.ok(
    read(path).includes("apps/extension/package.json"),
    `${path} must use the extension version.`,
  );
  assert.ok(!read(path).includes('"daemon/'), `${path} still uses the old daemon path.`);
}
console.log("Workspace paths, release versions and plugin launchers match.");
