# tabrunner.app

Marketing and download site for [TabRunner](https://github.com/tabrunner/tabrunner), a Chromium
extension that lets an LLM drive your real browser. Static site, deployed on its own cadence,
independent of the extension repo.

One page, five sections: hero with a live simulated run → feature constellation → product
screenshots → install flight plan → the privacy data map. English, Português (Brasil) and
Español.

## Stack

Vite · React 19 · Tailwind CSS 4 · i18next · bun. No router, no backend, no analytics.

```bash
bun install
bun run dev      # http://localhost:5173
bun run build    # typecheck → client build → SSR build → prerender → dist/
bun run preview  # serve the built dist/
bun run check    # self-checks: the run console's clock, and the address/head rules
```

## Design and product context

Two documents own the decisions; read them before changing the surface:

- **`PRODUCT.md`**: who this is for, what may and may not be claimed, distribution reality.
- **`DESIGN.md`**: "The Comet Field": the palette, type ramp, named rules, component specs, and the
  landing page's story under `## Landing`.

The direction contract also lives at the top of `src/App.tsx`. The short version:

- Two lights only: burn emerald for motion, telemetry amber for measurement. No third hue, and
  never the retired purple (nor the brief cyan).
- Glow means live. Static content sits flat; only running things and the primary action glow.
- Monospace is only ever data: time, tokens, commands, refs. Prose never wears mono.
- One authored moment (the mission line launching a comet). Sections do not animate in;
  content is visible at rest.
- Icons are authored SVG at one stroke weight, with no emoji, no unicode glyphs.
- No invented proof: no testimonials, logos, download counts, or star counts.

## The download contract

`src/lib/links.ts` is the only place install URLs live. GitHub URLs are **`releases/latest`
aliases only**. Never a hardcoded version number, anywhere.

| What                             | URL                                                         |
| -------------------------------- | ----------------------------------------------------------- |
| Store listing (primary CTA)      | `chromewebstore.google.com/detail/tabrunner/<extension id>` |
| Zip, loaded unpacked (secondary) | `releases/latest/download/tabrunner-latest-chrome.zip`      |
| Release notes                    | `releases/latest`                                           |

**We never build a CRX ourselves.** None has shipped since v0.2.3, and none should: a CRX3
installs only if its header carries a `sha256_with_ecdsa` _publisher proof_, signed by a key
only Google holds at publish time. Pinning the manifest `key` reproduces the extension **ID**,
not that proof, so a self-built CRX fails with `CRX_REQUIRED_PROOF_MISSING` however it is
signed. That was the bug behind the 2026-08 zip flip.

Because the extension pins its manifest key to the store item's, the zip and the store install
**share one extension ID**. Chrome refuses to run both, so the install caveats tell anyone on
the unpacked build to remove it before installing from the store.

### Why the store CRX endpoint is not linked

The store's own CRX _does_ carry the proof, and Chrome's update service will hand it over. This
works today (verified 2026-08-15 against our own item):

```bash
# Required: prodversion, acceptformat, and id. Everything else is optional.
# `prod` can be dropped, and installsource/uc are statistics only.
# Omitting prodversion or acceptformat returns 204 No Content, not an error.
curl -L "https://clients2.google.com/service/update2/crx\
?response=redirect&prod=chromium&prodversion=143.0.7499.41&acceptformat=crx3\
&x=id%3D<extension id>%26installsource%3Dondemand%26uc"
# → 302 to clients2.googleusercontent.com/crx/blobs/<opaque>/<ID>_0_2_1_0.crx
```

The `clients2` URL is stable; only its redirect target moves per release, and a browser follows
that transparently. A stale `prodversion` doesn't rot either: `90.0` still serves. So the
honest reason we don't link it is **not** that it breaks:

- It's an undocumented internal update channel with no support commitment for redistribution.
  It can change or start gating without notice, and nothing tells us when.
- It serves the **store's** last-approved build, which lags `releases/latest` (0.2.1 vs v0.2.8
  on the day of the flip), so it would be a "Download" that is neither newest nor the zip.
- It costs the visitor a download, a `chrome://extensions` trip and a drag, where the listing
  costs one click.
- It drops every trust signal: verified publisher, reviews, the permissions disclosure. For an
  extension that asks for debugger-level access, those are the last things to throw away.

**When it would earn its place**, as a clearly-labelled secondary link and never the primary CTA:
visitors in regions where the Chrome Web Store is blocked (the real reason some well-known
extension pages offer a direct CRX), offline or air-gapped installs, and pinning a specific build
for testing. If that day comes, add it beside the zip in `LINKS`, not in place of `store`.

Edge publishes an equivalent (`edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect
&x=id%3D<id>%26installsource%3Dondemand%26uc`, no `prodversion` needed). This is untested here, since
TabRunner has no Edge listing.

## Assets

```bash
bun run sync           # screenshots from ../chrome → public/screenshots (webp, 2 sizes)
bun run og             # regenerate public/og.png (1200×630 social card)
bun run shoot [url]    # screenshot the running site, report horizontal overflow
```

- **Screenshots** are captured in the extension repo (`chrome/docs/screenshots/`) and derived
  here into a 1280w and a 480w webp. Derivatives are committed, so a deploy needs neither this
  script nor the sibling repo. Requires `cwebp` (`brew install webp`).
- **The social card** is authored here by `scripts/gen-og.ts` from the comet-tab geometry and
  the vendored OFL fonts in `assets/fonts/`. It is no longer synced from the extension.
- **The comet-tab mark** has one geometry, in `src/components/CometMark.tsx`, mirrored in
  `public/favicon.svg` and `scripts/gen-og.ts`. Change it in all three or in none.
- `scripts/shoot.ts` scrolls the whole page before capturing. A `fullPage` screenshot never
  scrolls on its own, so anything gated on scroll position would otherwise photograph blank.

> **Known gap:** the product screenshots are from the pre-rename build. The panel is branded
> "Regent"/"Regentry", in the retired purple, with the old crown mark. The site labels them as
> old-brand (`shots.note`), but they need retaking against the current build before the site is
> promoted. See `PRODUCT.md` → Evidence on Hand.

## i18n

`src/i18n/locales/en-US.ts` is the reference locale and its shape is the `Locale` type. The
other two files fail to typecheck if they drift.

**The URL decides the language.** `/` is English, `/pt` is Portuguese, `/es` is Spanish, and
each is a real prerendered file announcing its own `<html lang>`, title, description, canonical and
hreflang set. It used to be one address whose language depended on who asked, which a crawler
cannot represent (it fetches an address once, and whatever it got is all that address will ever
mean, so two of the three languages were unreachable) and a reader cannot share (the link you send
shows the other person a different page than the one you were reading).

Detection is not gone, it is demoted: on an _unprefixed_ address only, `?lang=` → a remembered
choice → the browser language can redirect once, before the first render. A reader who followed a
link to `/pt` is never moved off it, and a crawler never takes the hop at all. The legal docs
are translated in the extension repo (`TERMS.pt-BR.md`, `PRIVACY.es.md`, …) and synced beside the
English, so `/terms`, `/pt/terms` and `/es/terms` each render their own language.

Adding a page means adding it to `src/config/publicPages.ts`. That registry is what gets rendered
to files and what the sitemap lists, so a page can't exist in one and not the other.

## Deploy

Push to `main` → GitHub Actions checks, builds, deploys `dist/` to Cloudflare Pages and then
verifies the deployment it just made against its own immutable URL, never the alias, which keeps
serving the previous build at 200 while the new one activates (`.github/workflows/deploy.yml`).
Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
repository secrets, and a Pages project whose name matches `--project-name` in the workflow.
`tabrunner.app` attaches as the custom domain.
