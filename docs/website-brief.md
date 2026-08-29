# tabrunner.app — Website Brief

Contract between this repo (`tabrunner`, the extension) and the site repo (tabrunner.app, the
marketing/download site, a sibling directory `../site`). The site is static, deploys on its own
cadence, and must **never hardcode a version number** — everything versioned comes from the
GitHub Releases URLs below.

## Download contract

Every pushed `v*` tag builds and attaches these to the GitHub Release
(`.github/workflows/release.yml`):

| URL (stable — hotlink these)                                                                  | What                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `https://github.com/tabrunner/tabrunner/releases/latest/download/tabrunner-latest-chrome.zip` | The download — keyed, installs under the store's id |
| `https://github.com/tabrunner/tabrunner/releases/latest`                                      | Release notes + versioned artifacts                 |

The versioned artifacts (`tabrunner-<version>-chrome.zip`, `-mcp.js`) sit on the same release for
the permanent record; the site links only the `latest` aliases and the release page, so shipping a
new version requires no site deploy.

The Chrome Web Store upload is that same `-chrome.zip`, submitted by hand — the store listing
carries no separate artifact, so there is nothing extra for the site to link or explain.

## Install instructions to present

The store listing is live (2026-08-15), so **Add to Chrome** (`LINKS.store`) is the primary
install and the unpacked zip is the fallback for anyone who needs it (a specific version, testing,
or a Chromium without store access).

**Primary — the store listing:**

- One button, _Add to Chrome_, to `LINKS.store`. One-click install, auto-updates, no
  developer-mode nag.

**Fallback — the zip, loaded unpacked:**

1. Download and unzip.
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the unzipped folder.

**Updating an unpacked install — the site must spell this out, because the obvious way destroys
the user's data.** Chrome keeps an unpacked extension's storage against its install, and the
install is the folder path. Reload that path and everything survives; press **Remove** and Chrome
deletes the providers, the sign-ins and every conversation with it. The zip's files sit at the
archive root, so unzipping a new version makes a _new_ folder (`tabrunner-latest-chrome 2`), and
loading that new path is a second install of the same id — which Chrome refuses, pushing the user
straight to Remove. So:

1. Download the zip and extract it **over the existing folder**, replacing the files.
2. `chrome://extensions` → press **⟳** on TabRunner.

Never Remove-then-reinstall to update. Say so on the page, next to the steps — a user who does it
the other way loses their API keys and their history with no warning and no way back.

**There is no CRX to link, and never will be.** Chrome only installs a CRX that arrives through
the store's own flow, and the store signs with a key only Google holds — so a self-signed CRX is
refused (`CRX_REQUIRED_PROOF_MISSING`) and the store's own CRX has no public URL a site may
hotlink. The per-revision link the dashboard shows (`.../revision/000NN/package/main/crx/3`) is a
dashboard preview: it changes every revision and Chrome blocks installing it from a page. Never
link a CRX — only `LINKS.store`.

Caveats the site must state plainly where they apply:

- The store and the unpacked build share one extension ID (`manifest.key`) — Chrome will not run
  both, so a user with the zip must remove it _before_ installing from the store. That Remove
  takes the storage with it: providers, sign-ins and conversations do not carry over, and there is
  no way to move them. Warn before the switch, not after.
- Unpacked installs show Chrome's "disable developer mode extensions" nag on each restart (this
  is the unpacked fallback's burden, absent from the store build).
- No auto-update for the unpacked build: new versions are downloaded and extracted over the
  existing folder, then reloaded — never re-installed (see **Updating** above). The download links
  are `latest` aliases, so the instructions never change.

## Content sources in this repo

- Product copy and permission justifications: `docs/store-listing.md` (written for a CWS reviewer;
  adapt tone for a landing page).
- What it is / how MCP works in both directions — the bridge clients dial in through, and the
  remote servers TabRunner connects out to — plus lifecycle webhooks: `README.md`, `docs/mcp.md`.
- Screenshots: `docs/screenshots/`.
- Social image: `docs/og.png`.
- Brand mark is generated from `src/shared/logo.ts` (`bun run icons`) — never hand-edit the PNGs.
  If the site needs other sizes, regenerate from the source, don't upscale.
- Brand color: the `brand-*` comet-burn emerald scale in `src/lib/theme.css`, with the
  `telemetry` gold reserved for anything that measures. Two lights only — the retired purple and
  the brief cyan must not come back.

## Hard requirements

- Chromium-only (Chrome, Brave, Edge, Arc…) — `chrome.debugger` has no Firefox/Safari equivalent;
  say so rather than offering dead download buttons for other browsers.
- Link the privacy doc (`PRIVACY.md`) — an agent that drives your logged-in browser must answer
  the data question up front.
