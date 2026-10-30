# TabRunner

One Bun + Turbo monorepo for the Chromium extension, tabrunner.app and the local MCP daemon.
Install dependencies once at the repository root with `bun install`.

| Path              | Purpose                                                  | Guide                                                                                                  |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/extension/` | WXT extension, package `tabrunner`                       | [AGENTS.md](apps/extension/AGENTS.md), [PRODUCT.md](apps/extension/PRODUCT.md)                         |
| `apps/site/`      | Static React site, package `tabrunner-site`              | [AGENTS.md](apps/site/AGENTS.md), [PRODUCT.md](apps/site/PRODUCT.md), [DESIGN.md](apps/site/DESIGN.md) |
| `packages/mcp/`   | Published `tabrunner-mcp` package and bridge smoke check | [README.md](packages/mcp/README.md), [bridge architecture](docs/agent/bridge.md)                       |
| `plugin/`         | Client plugin, skill and pinned MCP launchers            | [README.md](plugin/README.md)                                                                          |
| `docs/`           | Product, architecture and distribution documentation     | [Architecture](docs/agent/architecture.md)                                                             |

Read the target app's guide before editing it. Package commands run from that package's directory;
root commands below run from the repository root.

## Commands

```bash
bun run extension       # extension dev mode
bun run site            # site dev server
bun run build           # build all packages
bun run typecheck       # packages and root scripts
bun run lint            # packages and root scripts
bun run deadcode        # extension and MCP package
bun run i18n:check       # extension locale parity and static keys
bun run check:workspace # manual workspace and release-path self-check
bun run bridge:check    # isolated bridge smoke check, no Chrome needed
bun run zip             # apps/extension/dist/tabrunner-<version>-chrome.zip
bun run bridge:bundle   # dist/tabrunner-<version>-mcp.js
bun run release minor   # local gates, bump, commit, tag and artifacts; never pushes
```

Use scoped checks while working:

```bash
bunx turbo run lint typecheck --filter=./apps/site
```

Use the matching folder filter for the extension or MCP package. Build changed apps locally before
requesting release. `bun run check` holds the local gates but never runs the test suite. Run only
the test file you wrote or changed, from its package directory, with that package's test config.
The full `bun run test` is manual and requires an explicit request.

## Workspace rules

- Dependency ranges live in the root `workspaces.catalog`; workspaces use `catalog:`. Keep one
  root lockfile. The extension's `tabrunner` name controls WXT's public ZIP filename.
- Shared TypeScript, ESLint and formatting config stays at the root. Browser, service-worker and
  Bun types stay separate. Never weaken the extension's UI-only import boundary.
- The extension's `apps/extension/package.json` version owns the release. Root
  `scripts/release.ts` keeps the MCP package, registry entry, plugin manifests and launchers in step.
- `docs/website-brief.md` is the product/site contract. Keep claims and screenshot captions in step.
- Root `PRIVACY*` and `TERMS*` files are canonical. Site builds copy them locally with
  `apps/site/scripts/sync-legal.ts`; no GitHub fetch is needed.
- Root `docs/screenshots/` holds the source PNGs. Extension `shots` refreshes the site's committed
  WebP derivatives. Brand geometry still has copies in both apps; change all copies together.
- Download links use the existing `tabrunner/tabrunner/releases/latest` aliases, never a version.
  Keep root public docs, legal paths, `plugin/` and marketplace discovery stable.
- Both apps publish en, pt-BR and es. Add translation keys to every catalog in the same edit.
- Reference repositories are not part of this repository. Never import code from a sibling checkout
  or its `node_modules`.

## Shipping

Work in a task worktree from `origin/main`. Commit slices by path and open a draft PR until release
is approved. A ready PR typechecks affected packages and root scripts, then squash-merges unless it
is a draft or has `hold`. CI dispatches the site deploy when its shipped inputs changed since its
last successful deployment. Nothing runs on main pushes. Manual merges need a manual deploy.

Site deployment is `.github/workflows/deploy-site.yml`, targeting the existing Cloudflare Pages
project `tabrunner`. It needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` repository secrets.
Extension/npm/registry publication remains the `v*` tag workflow, not a side effect of a site deploy.
Do not publish, deploy or change production settings without approval.
