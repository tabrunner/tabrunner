# Product

## Platform

web

## Users

AI power users and developers: people who already pay for (or self-host) an LLM provider, are
comfortable installing an extension via `chrome://extensions`, and want an agent to do real work in
the browser they actually use — with their own tabs, sessions, and logins.

## Product Purpose

TabRunner is a Chromium extension that lets an LLM drive the user's **real** browser — not a
sandbox. The user describes a task in the side panel; TabRunner reads pages (accessibility-tree
snapshots), clicks and types (trusted input via the Chrome DevTools Protocol), and navigates until
the job is done. Tagline: **"You give the goal. It runs the tabs."** (2026-08, user-confirmed;
carried everywhere now — hero, footer, OG card, and the extension README all speak it.) Success
for the site: a visitor understands what it is in seconds, trusts it enough to install, and
completes the install.

## Positioning

Two claims a neighboring product cannot copy:

1. **It runs in your browser, not a sandbox** — it acts on the sites you're already logged into,
   with genuine trusted input events (CDP), not synthetic JS dispatches sites can ignore.
2. **Provider-agnostic by construction** — 15 presets across 12 vendors (Anthropic, OpenAI and
   Kimi appear twice: subscription sign-in and API key), plus any OpenAI/Anthropic-compatible
   endpoint. No TabRunner server, no relay, no account, no telemetry. Your key goes straight
   from the extension to your provider. Source of truth:
   `apps/extension/src/modules/providers/presets.ts` — the site's chip list is the 12 vendor names.
   **Prose naming the subscriptions names the products instead — Claude, ChatGPT, Kimi** — which
   is what the extension's own subscription rows say, and what people recognize as the thing
   they pay for. The chip list stays vendors because it counts providers, not rows, so the copy
   has to bridge the two vocabularies itself ("Anthropic, OpenAI and Kimi appear twice") — drop
   that clause and the sentence sells a Claude plan the chips below never mention.

## Operating Context

- Distribution: the Chrome Web Store listing is approved **2026-08-15** and is now the
  primary install (`LINKS.store` flips to an _Add to Chrome_ button); GitHub Releases (`tabrunner/tabrunner`)
  remains the unpacked zip fallback. Chrome installs a CRX only through the store's own flow, so
  no CRX ships at all. The zip and the store install share one ID, since the extension pins its
  manifest key to the store item's — Chrome refuses to run both, so the unpacked build must be
  removed _before_ the store install. The store description is plain text (CWS renders no
  Markdown in it — `docs/store-listing.md` learned this the hard way at approval). The
  site must **never hardcode a version number** — only `releases/latest` aliases.
- Also drivable over MCP from Claude Code/Desktop or any MCP client (local daemon bridge).
- Chromium-only by design: Chrome, Brave, Edge, Arc, Opera, Vivaldi. Firefox/Safari have no
  `chrome.debugger` equivalent — say so, don't offer dead buttons.
- Extension UI is localized: English, Português (Brasil), Español; light/dark/OS theme.

## Capabilities and Constraints

- Site stack: Vite + React 19 + Tailwind CSS 4 + bun, static, deployed on its own cadence.
- Hard requirements from `docs/website-brief.md`: hotlink only the stable release URLs
  (`tabrunner-latest-chrome.zip`, `releases/latest`) — never a CRX, which no longer ships and
  could not be installed from a link anyway; state the sideload caveats plainly (developer-mode
  warning, folder must stay put, no auto-update); link the privacy doc
  (`github.com/tabrunner/tabrunner/blob/main/PRIVACY.md`) up front — an agent that drives your
  logged-in browser must answer the data question immediately.

## Brand Commitments

- Name: **TabRunner** ("it runs your tabs"). Mark: the **comet-tab** — a browser-tab silhouette
  in motion with its burn trail; generated from `apps/extension/src/shared/logo.ts`, never hand-edited.
- Brand color (2026-08, user-confirmed): **comet-burn** — deep-space indigo ground, emerald comet
  trails (the green a comet burns on entry; the runner's "go"), warm amber for live telemetry.
  This replaced the original royal purple (`#8b5cf6` family) after a brief cyan pass
  (`#22d3ee` family, rejected in review); the extension carries the same palette via its
  `brand-*` tokens, and icons/OG/screenshots regenerate from source in it.
- Voice: direct, technically honest, zero hype. No invented testimonials, customers, benchmarks,
  or pricing. Avoid the generic AI-hype SaaS feel (user-confirmed anti-vibe).

## Evidence on Hand

- `docs/screenshots/`: 4 real 1280×800 product shots (side panel, chat/run, providers,
  status widget) — retaken in the comet-burn brand (chrome d865dea, 2026-08-09) and synced here as
  webp the same day; `shots.note` tells visitors they're the current build.
- `apps/site/public/og.png`: 1200×630 social card, regenerated 2026-08-09 in comet-burn with the
  current tagline — authored by `apps/site/scripts/gen-og.ts`, no longer synced from the extension.
- `apps/extension/public/icon/`: comet-tab tiles on the deep-field ground (16–128), regenerated from
  `apps/extension/src/shared/logo.ts` — the retired purple/crown lives only in git history.
- `README.md`, `docs/mcp.md`, `docs/store-listing.md`: copy source.
- `PRIVACY.md`: privacy policy (linked on GitHub).
- No testimonials, customer logos, usage numbers, or pricing exist — never fabricate them.

## Product Principles

1. Prove, don't claim — show the real product working; the privacy answer comes first, not last.
2. Honest distribution — install instructions state every caveat a sideloaded build carries.
3. No dark patterns of omission — Chromium-only is stated, not hidden behind dead buttons.
4. Playful but credible — the comet energy serves developers who read footnotes.
