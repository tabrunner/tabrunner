import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
}

let mergeScript = "";
for (const [name, event] of Object.entries({
  ci: "pull_request",
  "deploy-site": "workflow_dispatch",
  release: "push",
})) {
  const workflow = Bun.YAML.parse(read(`.github/workflows/${name}.yml`));
  assertRecord(workflow);
  const triggers = workflow.on;
  assertRecord(triggers);
  assert.deepEqual(Object.keys(triggers), [event]);
  if (name === "release") {
    assertRecord(triggers.push);
    assert.deepEqual(triggers.push.tags, ["v*"]);
    assert.ok(!("branches" in triggers.push));
  }
  const jobs = workflow.jobs;
  assertRecord(jobs);
  for (const job of Object.values(jobs)) {
    assertRecord(job);
    if (name === "deploy-site") assert.equal(job.if, "github.ref == 'refs/heads/main'");
    assert.ok(Array.isArray(job.steps));
    const runs: string[] = [];
    for (const step of job.steps) {
      assertRecord(step);
      if (step.uses === "oven-sh/setup-bun@v2") {
        assertRecord(step.with);
        assert.equal(step.with["bun-version-file"], "package.json");
      }
      if (typeof step.run === "string") {
        execFileSync("bash", ["-n"], { input: step.run });
        runs.push(step.run);
      }
    }
    if (name === "ci") {
      assert.equal(runs.length, 3, "CI only installs, typechecks and merges/dispatches.");
      assert.equal(runs[1], "bunx turbo typecheck typecheck:tooling --filter='...[origin/main]'");
      mergeScript = runs[2] ?? "";
    }
  }
}

// Exercise the real workflow function with local command fakes. Never merge or deploy.
const changed = mergeScript.match(/^changed\(\) \{[\s\S]*?^\}/m)?.[0];
const route = mergeScript.match(/^if (changed [^\n]+); then$/m)?.[1];
assert.ok(changed && route, "CI must retain its last-successful-deploy routing check.");
const routingCheck = `
set -euo pipefail
REPO=local
gh() { if [ "$BASE_PRESENT" = true ]; then printf baseline; fi; }
git() {
  case "$1" in
    cat-file) return 0 ;;
    diff) printf '%s' "$CHANGED_FILES" ;;
    *) return 1 ;;
  esac
}
${changed}
if ${route}; then printf deploy; else printf skip; fi
`;
for (const [files, expected, baseline] of [
  ["apps/site/src/App.tsx", "deploy", true],
  ["apps/extension/src/entrypoints/background.ts", "skip", true],
  ["packages/mcp/src/index.ts", "skip", true],
  ["README.md", "skip", true],
  ["PRIVACY.md", "deploy", true],
  ["TERMS.pt-BR.md", "deploy", true],
  ["PRIVACY.es.md", "deploy", true],
  ["bun.lock", "deploy", true],
  ["docs/screenshots/01-side-panel.png", "deploy", true],
  [".github/workflows/deploy-site.yml", "deploy", true],
  [".github/workflows/release.yml", "skip", true],
  ["apps/extension/old.ts\napps/site/new.ts", "deploy", true],
  ["", "skip", true],
  ["apps/extension/src/main.ts", "deploy", false],
] as const) {
  const result = execFileSync("bash", ["-c", routingCheck], {
    encoding: "utf8",
    env: { ...process.env, CHANGED_FILES: files, BASE_PRESENT: String(baseline) },
  });
  assert.equal(result, expected, `Wrong site-deploy selection for ${files || "an empty diff"}`);
}
console.log("Workspace paths, release versions, plugin launchers and deployment selection match.");
