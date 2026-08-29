# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

AI power users and developers: people who already pay for (or self-host) an LLM provider, are
comfortable installing an extension via `chrome://extensions`, and want an agent to do real work in
the browser they actually use — with their own tabs, sessions, and logins. A second confirmed
audience drives the same browser over MCP from a local client (Claude Code, Claude Desktop, any
MCP client) instead of typing in the panel.

## Product Purpose

TabRunner is a Chromium extension that lets an LLM drive the user's **real** browser — not a
sandbox. The user describes a task in the side panel; TabRunner reads pages (accessibility-tree
snapshots), clicks and types (trusted input via the Chrome DevTools Protocol), and navigates until
the job is done. Tagline: **"You give the goal. It runs the tabs."** (2026-08, user-confirmed;
carried by the README and OG card.) Success: a run completes a real task on the user's logged-in
sites with the user able to watch every step, answer when asked, and stop it on the spot.

## Positioning

Two claims a neighboring product cannot copy:

1. **It runs in your browser, not a sandbox** — it acts on the sites you're already logged into,
   with genuine trusted input events (CDP), not synthetic JS dispatches sites can ignore.
2. **Provider-agnostic by construction** — 15 presets across 12 vendors (Anthropic, OpenAI and
   Kimi appear twice: subscription sign-in and API key), plus any OpenAI/Anthropic-compatible
   endpoint. No TabRunner server, no relay, no account, no telemetry. Your key goes straight from
   the extension to your provider. Source of truth: `src/modules/providers/presets.ts`.

## Operating Context

- The run workflow: describe a task in the side panel → approve the plan it proposes → watch the
  live plan, current action, token spend and elapsed time → stop with Esc or the Stop button. Runs
  survive panel close; a notification reports completion, failure, or a question.
- Guardrails are the product, not a settings page: the plan gate blocks action tools until the
  user approves; `ask_user` enforces the consequential-action policy (paying, sending, deleting);
  a user stop ends a run cleanly (`done`, never an error).
- Distribution: the Chrome Web Store listing is the primary install (**approved 2026-08-15**);
  the GitHub Releases keyed zip (loaded unpacked) is now the fallback. Both install under one ID
  (`ilnohobdcigbmlikjbkdpbkhciephdle`, pinned via manifest `key`) — Chrome refuses to run both, so
  the unpacked build must go _before_ the store install. The store description is authored in
  plain text (`docs/store-listing.md`) — CWS renders no Markdown in it.
- Also drivable over MCP: the daemon bridge (`daemon/`) hands tasks to the same browser and
  logins; runs land in history labelled by client.
- Chromium-only by design (Chrome, Brave, Edge, Arc, Opera, Vivaldi): Firefox/Safari have no
  `chrome.debugger` equivalent. Stated plainly, never hidden behind dead buttons.
- UI is localized en / pt-BR / es, typed off the English catalog; light / dark / OS theme.

## Capabilities and Constraints

- The model never receives raw HTML — it works from a compact accessibility tree (`[ref=e12]
button "Submit"`); `sanitize.ts` caps tool output and keeps passwords, one-time codes and card
  numbers from leaving the page.
- Trusted input, network/console rings, page-side `fill`/`evaluate` (CSP-exempt) — all over the
  debugger channel, attach-scoped to the tab being worked.
- Memory: the user's `AGENTS.md` and the agent's `MEMORY.md` load into every run — a `## site:`
  section only when the run starts on that site; the `remember` tool and post-run distillation
  maintain them; one toggle stops both halves.
- Remote MCP + webhooks: TabRunner dials out to remote MCP servers (https; static auth headers)
  whose tools join every run behind the plan gate — `/mcp` in the panel reports what's connected,
  and a server that elicits reaches the user as a panel card (declined on unattended runs).
  Run events (started/finished/error/ask) POST to user-configured webhooks, fire-and-forget.
- Scheduled tasks: one-shot, daily, or every-N-minutes (with an optional weekday filter and
  active-hours window), fired by `chrome.alarms` into the same run queue. Created by asking in the
  panel — the plan gate is the consent — and reviewed in Settings → Schedules. The agent holds
  `schedule_task` and `cancel_schedule`, which is also how it paces itself; a scheduled run may
  only re-time its own schedule, never create new ones, and 20 records / 20 self-reschedules bound
  the unattended spend.
- Reasoning effort (`none` → `max`) is the only model knob — no sampling params ever. Auto model
  resolution runs the newest model the endpoint lists.
- MV3 reality: a service worker kept alive by an open Port or alarms; durable state in
  `chrome.storage`; the bridge protocol is declared twice on purpose
  (`src/modules/bridge/protocol.ts` ↔ `daemon/src/protocol.ts`).
- Release mechanics: `package.json` version is the single source of truth; `bun run release`
  gates, bumps, tags and builds one keyed `-chrome.zip` that serves the site, dev loads and the
  Chrome Web Store alike. No CRX ships, ever.

## Brand Commitments

- Name: **TabRunner** ("it runs your tabs"). Mark: the **comet-tab** — a browser-tab silhouette in
  motion with its burn trail. One geometry, generated: `src/shared/logo.ts` here,
  `site/src/components/CometMark.tsx` and `site/public/favicon.svg` on the site, plus both OG
  generators. Change all or none; never hand-edit `public/icon/*`.
- Brand color (2026-08, user-confirmed): **comet-burn** — burn emerald (`brand-*` scale,
  `src/lib/theme.css`) is the color of action/motion; **telemetry gold** measures (elapsed,
  tokens, steps in flight). Two lights only: emerald acts, gold measures. The retired royal purple
  and the brief cyan never come back.
- Dark mode grounds are deep-field indigo-tinted neutrals (`neutral-*` retinted in `theme.css`),
  shared with the site's night sky; light mode is a clean tool surface.
- Voice: direct, technically honest, zero hype. No invented testimonials, customers, benchmarks,
  or pricing.

## Evidence on Hand

- `docs/screenshots/`: 4 real 1280×800 product shots (side panel, finished run, providers,
  status widget), regenerated in the comet-burn rebrand (d865dea, 2026-08-09) via `bun run shots`.
  (The site repo's PRODUCT.md still calls them stale old-brand — that note predates the retake.)
- `docs/og.png`: social card, regenerated with the comet mark (`bun run icons`).
- `docs/store-listing.md`: the store copy source of truth, including permission justifications
  written for a reviewer.
- `README.md`, `docs/mcp.md`, `docs/website-brief.md`: copy and the cross-repo contract.
- `PRIVACY.md`, `TERMS.md`: legal text authored here; the site syncs it (`site/ bun run
sync:legal`).
- No testimonials, customer logos, usage numbers, or pricing exist — never fabricate them.

## Product Principles

1. The user's browser is the product — act with their authority, never around it: plan approved
   before action, asked before consequences, stoppable on the spot.
2. Prove, don't claim — the run shows its plan, actions and spend live; the privacy answer comes
   first, not last.
3. No server in the middle — keys go straight to the provider, data stays on the device, features
   must not assume a backend exists.
4. Honest constraints — Chromium-only and the unpacked fallback's sideload caveats are stated in
   plain view, never smoothed over.

## Accessibility & Inclusion

- UI localized en / pt-BR / es; every user-visible string goes through i18n (`i18n:check` gates
  parity).
- Light / dark / OS theme; every color utility carries a `dark:` counterpart.
- Motion signals (run shimmer, thinking dots, the sign-in success beat) all ship reduced-motion
  fallbacks — motion is a state signal here, so the fallback must carry the same meaning.
