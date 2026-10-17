/**
 * One-command release: gates → version bump → commit → tag → zip + daemon.
 *
 *   bun run release patch   # 0.1.0 → 0.1.1
 *   bun run release minor   # 0.1.0 → 0.2.0
 *   bun run release major   # 0.1.0 → 1.0.0
 *
 * package.json `version` is the single source of truth: the git tag (`v0.1.0`),
 * the artifact names (`dist/tabrunner-0.1.0-chrome.zip`, `-mcp.js`) and the
 * daemon's npm package (`tabrunner-mcp`, daemon/package.json) all derive from
 * it. Never pushes — pushing stays an explicit act; the final line names the
 * command. The push fires the Release workflow, which rebuilds the artifacts,
 * attaches them (plus `latest` aliases the website hotlinks) to the tagged
 * GitHub Release, and publishes the daemon to npm and the MCP Registry.
 */
import { $ } from "bun";
import { fileURLToPath } from "node:url";

// Anchor git, the gates, and the dist scan to the package root so the script
// works from any invocation directory.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = "Usage: bun run release <patch|minor|major>";
/**
 * Every other file that names the release, so the extension, the daemon's npm
 * package (`bunx tabrunner-mcp`), the plugin that starts it and its MCP Registry
 * entry (which also pins the package version) all say one version.
 */
const FOLLOWERS = [
  "daemon/package.json",
  "daemon/server.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/plugin.json",
];
/**
 * The plugin's launchers, which pin the daemon's exact npm version: Claude's plugin
 * directory refuses `bunx` with `@latest` or a range ("Unpinned npx launcher").
 */
const PINNED = ["plugin/.mcp.json", "plugin/mcp.json"];
/** What the bump writes: every version, and the lockfile line that records the daemon's. */
const BUMPED = ["package.json", ...FOLLOWERS, ...PINNED, "bun.lock"];

const bump = process.argv[2];
if (bump !== "patch" && bump !== "minor" && bump !== "major") {
  console.error(
    bump
      ? `Unknown bump "${bump}" — expected patch, minor, or major.`
      : "Missing bump level — expected patch, minor, or major.",
  );
  console.error(USAGE);
  process.exit(1);
}

// A release commit must contain exactly the version bump — never sweep in
// unrelated in-progress edits.
const status = (await $`git status --porcelain`.quiet()).stdout.toString().trim();
if (status) {
  console.error(
    "Working tree is not clean — commit, stash (`git stash -u`), or remove these first:",
  );
  console.error(status);
  console.error(
    `If ${BUMPED.join(", ")} are the only changes, a previous release was interrupted. Discard them:`,
  );
  console.error(`  git restore --staged --worktree ${BUMPED.join(" ")}, then re-run.`);
  process.exit(1);
}

// All gates green before anything is written, so a gate failure leaves no bump,
// commit, or tag behind. The zip step builds, so no separate build gate.
// ponytail: hardcoded gate snapshot — must match AGENTS.md "Before submitting
// work"; change both together. A removed gate fails loudly here on release;
// a new gate missing from this list silently never runs.
for (const gate of ["compile", "lint", "test", "deadcode", "i18n:check"]) {
  console.log(`▪ gate: ${gate}`);
  try {
    await $`bun run ${gate}`;
  } catch {
    console.error(`✗ Gate "${gate}" failed — release aborted, nothing was changed.`);
    process.exit(1);
  }
}

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = (await Bun.file(pkgPath).json()) as { version: string };
const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!parts) {
  console.error(
    `Version "${pkg.version}" is not x.y.z — edit package.json by hand, then tag to match.`,
  );
  process.exit(1);
}
const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
const next =
  bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

// A stale tag from an undone release would die below after the bump is already
// committed — check while nothing has been written yet.
if ((await $`git rev-parse -q --verify ${`v${next}`}`.quiet().nothrow()).exitCode === 0) {
  console.error(`Tag v${next} already exists — nothing was changed.`);
  console.error(
    `  If it's stale: git tag -d v${next} — then re-run. Otherwise release a level up.`,
  );
  process.exit(1);
}

// A follower that drifted would keep its old version through the replace below,
// so check them all while nothing has been written yet.
const current = `"version": "${pkg.version}"`;
const pin = `tabrunner-mcp@${pkg.version}`;
const followers = await Promise.all(
  FOLLOWERS.map(async (file) => ({ file, text: await Bun.file(file).text() })),
);
const pinned = await Promise.all(
  PINNED.map(async (file) => ({ file, text: await Bun.file(file).text() })),
);
const drifted = [
  ...followers.filter(({ text }) => !text.includes(current)),
  ...pinned.filter(({ text }) => !text.includes(pin)),
].map(({ file }) => file);
if (drifted.length > 0) {
  console.error(
    `Not at ${pkg.version} like package.json: ${drifted.join(", ")}. Nothing was changed.`,
  );
  console.error("  Set their version to match by hand, commit, then re-run.");
  process.exit(1);
}

// Replace the string rather than re-serialize, so each file keeps its formatting.
for (const { file, text } of followers) {
  await Bun.write(file, text.replaceAll(current, `"version": "${next}"`));
}
for (const { file, text } of pinned) {
  await Bun.write(file, text.replaceAll(pin, `tabrunner-mcp@${next}`));
}
pkg.version = next;
await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

try {
  // bun.lock records each workspace's version: rewrite that line, install nothing.
  await $`bun install --lockfile-only`.quiet();
  await $`git add ${BUMPED}`;
  await $`git commit -m ${`Release v${next}`}`;
} catch {
  console.error(
    `✗ Commit failed. The v${next} bump is written to ${BUMPED.join(", ")} but not committed.`,
  );
  console.error(`  Unwind: git restore --staged --worktree ${BUMPED.join(" ")}`);
  process.exit(1);
}

try {
  await $`git tag -a ${`v${next}`} -m ${`v${next}`}`;
} catch {
  console.error(
    `✗ Tag v${next} failed, but its release commit exists. Do NOT re-run release — it bumps again.`,
  );
  console.error(
    `  Finish: git tag -a v${next} -m v${next}   ·   or abandon: git reset --hard HEAD~1`,
  );
  process.exit(1);
}

// One zip for every channel: the keyed `-chrome.zip` is the website's unpacked
// install AND the Chrome Web Store upload — the listing exists, so CWS derives
// the id from its own item record and takes the manifest `key` in stride.
try {
  await $`bun run zip`;
} catch {
  console.error(
    `✗ zip failed, but v${next} is already committed and tagged. Do NOT re-run release — it bumps again.`,
  );
  console.error("  Fix the build, then finish by hand: bun run zip");
  process.exit(1);
}

// The daemon bundle names itself after the new version, so it builds here,
// after the bump — the Release workflow rebuilds it (canonical) on push.
try {
  await $`bun run bridge:bundle`;
} catch {
  console.error(
    `✗ Daemon bundle failed, but v${next} is already committed and tagged. Do NOT re-run release — it bumps again.`,
  );
  console.error("  Fix the build, then finish by hand: bun run bridge:bundle");
  process.exit(1);
}

const artifacts = [...new Bun.Glob(`tabrunner-${next}-*.{zip,js}`).scanSync("dist")];
console.log(`\n✔ Released v${next}`);
for (const artifact of artifacts) console.log(`  artifact  dist/${artifact}`);
console.log(`  tag       v${next}`);
console.log("  publish   git push --follow-tags — CI attaches the artifacts to the GitHub Release");
