# tabrunner.app

Static marketing, download and MCP guide site for TabRunner. The extension lives in
[../extension](../extension/AGENTS.md); architecture and public setup docs stay in the root docs/.
Read the root [workspace guide](../../AGENTS.md) for shared commands. Paths beginning with apps/,
packages/ or docs/ below refer to the repository root.

## Commands

Run these from apps/site after installing once at the repository root:

```bash
bun run dev       # Vite dev server
bun run typecheck # site source and Vite config
bun run lint      # site source and Vite config
bun run build     # local legal sync, typecheck, client/SSR builds and prerender into dist/
bun run check     # manual run-console and prerender/discovery self-checks
bun run sync      # root docs/screenshots PNGs into public/screenshots WebP files
bun run sync:legal # root PRIVACY/TERMS translations into src/legal/, read all before writing
bun run og        # regenerate public/og.png
bun run shoot     # local screenshots and overflow report in preview/shots/
```

Build locally before requesting release. CI only typechecks. After an approved merge, root CI
starts [.github/workflows/deploy-site.yml](../../.github/workflows/deploy-site.yml) when site inputs
changed since its last successful deployment. The deploy is workflow_dispatch-only; main pushes
and manual merges do not deploy. Cloudflare Pages project tabrunner and its domain stay unchanged.

The deploy verifies its own immutable URL: localized pages, real 404s, robots/sitemap and the local
stdio discovery files. Never replace this with a check against the domain's previous deployment.
Downloads keep the existing releases/latest aliases and never name a version.

## Conventions

- Vite + React 19 + Tailwind 4 + bun. TypeScript strict. No component library — hand-built
  sections in `src/components/`, one per section (Hero, Features, Screenshots, Install, Privacy,
  Footer, Nav, RunConsole, CometField, CometMark), plus the DocsPage and its CodeBlock, and the
  LanguageSwitcher that Nav (from `sm`) and Footer (phones) share.
- **i18n:** en-US / pt-BR / es-ES, catalogs in `src/i18n/locales/*.ts` (typed off en-US). Add keys
  to all three catalogs in the same edit. No user-visible string is a literal.
- **The URL decides the language, not the browser.** `/` is en-US, `/pt` and `/es` carry a
  lowercase segment (`src/config/locale.ts`); the switcher is three `<a href>`s. Detection survives
  as ONE hop off an unprefixed address, before the first render, which a crawler never takes.
- **Every published page is a real file.** `scripts/prerender.ts` renders each row of
  `src/config/publicPages.ts` in each language it is published in, with its own head (`<html lang>`,
  title, description, canonical, reciprocal hreflang + x-default), and writes a 404 shell per
  language, `sitemap.xml` and `robots.txt`. Files are FLAT (`pt.html`, never `pt/index.html`:
  a directory index makes `/pt` a 308). `assertRendered` fails the BUILD on the bytes written.
  There is no catch-all rewrite — a miss is a real 404. A page in `App.tsx` but not in the registry
  ships nothing; add both. The legal docs publish in all three languages, because the extension
  repo carries a translation of each (`TERMS.pt-BR.md`, `PRIVACY.es.md`, …).
- **`/docs` is authored here**, not synced: its text lives in the `docs.*` keys of all three
  catalogs, and the anchor ids live in `DocsPage.tsx` so a link means the same thing in every
  language. Its MCP commands live in `src/config/mcp.ts` and repeat `docs/mcp.md`, the
  extension's Settings → MCP pane (`apps/extension/src/entrypoints/options/McpPane.tsx`) and the package in
  `packages/mcp/server.json`: change all four together. Every claim on it comes from the extension
  repo's README or docs. Check it there before adding one.
- **The MCP server is local.** The client starts `bunx tabrunner-mcp@latest` on the reader's
  computer (stdio), and a loopback broker with a private token joins it to the extension. TabRunner
  has no public MCP URL and no public API, so the site publishes no `WebAPI` data and no OAuth
  metadata, and `/.well-known/mcp.json` must keep `transport: "stdio"` and carry no `url`.
  `src/config/discovery.ts` writes that file, `/llms.txt`, `/llms-full.txt` (English, from the same
  `docs.*` catalog the guide renders) and the `SoftwareApplication` JSON-LD baked into `/` and
  `/docs`. They come from `@gusnips/vite` (`mcpDiscoveryJson`, `llmsTxt`, `jsonLd`), and
  `scripts/prerender.ts` writes them to `dist/`. `bun run check` holds the stdio rule.
- **Brand:** DESIGN.md is the design system — read it before any visual work. Token scales live
  in `src/index.css` (`field-*` deep indigo grounds, `flare-*` comet-burn emerald = motion,
  `tel-*` amber = measurement, `star-*` text). Two Lights rule: only emerald and amber emit
  light; glow means live. The retired purple and the brief cyan must not come back.
- **The comet-tab mark** geometry is shared with the extension (`src/components/CometMark.tsx`
  ↔ `apps/extension/src/shared/logo.ts`) — the two must not drift; same for the OG composition
  (`scripts/gen-og.ts` ↔ `apps/extension/scripts/gen-icons.ts`).
- Fonts: Unbounded (display) / Figtree (body) / JetBrains Mono (telemetry), via
  `@fontsource-variable/*`; OFL TTFs for resvg in `assets/fonts/`.
- Prettier: 2-space, double quotes, semicolons, width 100.

## Product screenshots

`public/screenshots/*.webp` derive from the extension workspace: `bun run shots` there stages the
four shots and runs this workspace's sync. What each shows (keep the section's captions in step):

- `01-side-panel` — Wikipedia "Web browser" article with the side panel beside it, pre-task: the
  task typed in the composer, not yet sent. The panel is the product, not a browser takeover.
- `02-chat` — Wikipedia "Intelligent agent" with a finished run in the panel: user bubble, plan
  card (3/3), tool trace, the agent's summary; the "TabRunner is controlling this tab" badge on
  the page (deep-field pill, amber dot).
- `03-providers` — options page, Providers tab: Anthropic + OpenAI subscription rows and a
  DeepSeek API-key row, active provider in flare.
- `04-chat-2` — Hacker News front page with a second conversation and the floating status
  widget (TabRunner · task · +1 queued · Open · Hide).
