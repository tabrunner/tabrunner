# TabRunner — Agent Guide

Provider-agnostic browser agent extension — lets an LLM drive your real browser with existing
logged-in sessions. Chromium-only (`chrome.debugger` has no Firefox/Safari equivalent).

## Commands

```bash
bun run dev        # dev mode with hot reload
bun run build      # production build → dist/chrome-mv3
bun run test       # vitest
bun run lint       # eslint
bun run compile    # tsc --noEmit (this IS the typecheck)
bun run format     # prettier
bun run deadcode   # knip (deadcode:fix to auto-fix)
bun run i18n:check # locale parity + every static t() key resolves (--unused for orphans)
bun run icons      # regenerate public/icon/* + docs/og.png from src/shared/logo.ts
bun run shots      # store screenshots → docs/screenshots/ (+ site sync when ../site exists)
bun run shots:ui   # light/dark UI previews → preview/ (gitignored)
bun run zip        # build + pack dist/tabrunner-<version>-chrome.zip (the website's download)
bun run zip:store  # same build minus the manifest `key` → dist/tabrunner-<version>-store.zip (CWS)
bun run release    # bun run release <patch|minor|major> — gates, bump, commit, tag, zip
bun run bridge     # run the MCP daemon by hand (clients spawn it themselves)
bun run bridge:check # end-to-end check of the MCP bridge — no Chrome needed
bun run bridge:bundle # single-file daemon → dist/tabrunner-<version>-mcp.js (what releases ship)
```

`daemon/` is a bun workspace, so one `bun install` covers both packages and `compile` typechecks
both.

Load: `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome-mv3`.

Before submitting work: `compile`, `lint`, `test`, `deadcode`, `i18n:check` — all green.

## Releasing

`version` in `package.json` is the single source of truth; the git tag and artifacts derive from
it (the manifest version comes from WXT automatically).

```bash
bun run release minor   # gates → bump → commit "Release vX" → tag vX → zips + daemon; never pushes
```

A gate failure writes nothing. Publishing is manual: `git push --follow-tags`, upload
`dist/tabrunner-<version>-store.zip` to the Chrome Web Store. **Two zips ship per version and
they are not interchangeable**: `-chrome.zip` carries the manifest `key` — the store listing's own
public key, which is what pins the unpacked install from tabrunner.app and every dev build to the
one id (`ilnohobdcigbmlikjbkdpbkhciephdle`), per
[Chrome's consistent-ID guidance](https://developer.chrome.com/docs/extensions/reference/manifest/key).
`-store.zip` is the same build with that field dropped. The store never needs it (it derives the
id from the item record) and its validator rejects a new item's first upload outright ("key field
is not allowed in manifest"), so stripping is the one path that always uploads. The pushed tag fires `.github/workflows/release.yml`, which attaches
versioned artifacts plus `tabrunner-latest-*` aliases that tabrunner.app hotlinks (and the MCP
daemon bundle, `tabrunner-latest-mcp.js`, that Settings → MCP points users at). CI does not build
the store zip — that one is submitted by hand, so it stays out of the public artifacts.

**No CRX.** Retired 2026-08-10. Chrome refuses to install a CRX served from anywhere but the
store, and the store's own CRX is signed with a key only Google holds, so a self-signed one was
unusable at both ends. Distribution is the keyed zip (unpacked) and the store listing, nothing
else. The `CRX_SIGNING_KEY` repo secret and any local `tabrunner-test.pem` are dead — delete them.

The website contract lives in `docs/website-brief.md` — change it and the site repo (`../site`)
together.

## Architecture

WXT (MV3) + React 19 + TypeScript + Tailwind 4 + Base UI (`@base-ui-components/react` — NOT
Uber's `baseui`) + zustand. Bun for everything.

Domain-first `src/modules/<domain>/`. Each module has an `index.ts` barrel and colocated
`__tests__/`.

**Runtime boundary — one rule, no exemptions.** Within a domain, everything under `ui/` is
UI-only (including its zustand `store.ts`); everything else is background-safe. ESLint
`no-restricted-imports` forbids any file outside a `ui/` folder (plus `src/components/**`,
entrypoints, tests) from importing `react`, `react-dom`, `zustand`, or `*/ui/*` — so React can
never reach the service-worker bundle.

### Modules

- `agent/` — agent loop, tools, system prompt, run slot + FIFO queue, run start. A panel run
  **adopts the user's current tab on the thread's first message** — drives it as-is (the plan
  gate protects a page the user didn't want touched) — and every follow-up **continues on
  the conversation's own tab while it lives**: a message typed elsewhere is usually steering,
  not a move order, so the send-time page rides along as model context (`submitPage`) instead
  of silently becoming the target. Every tab the run acts on joins one green strip per
  conversation per window (Chrome groups can't span windows), found by content — a group is
  the thread's only while it holds a url the conversation drove and still looks like ours —
  minted at the first action, never at send time; a tab already in somebody's group is never
  ripped into it. It opens its own
  tab only when there's no page to work: blank/new-tab, a restricted page, an MCP client,
  or an explicit URL. Runs survive panel close.
  Action tools
  are gated on user-approved plans; `ask_user` enforces the consequential-action policy.
- `browser/` — accessibility-tree snapshot, CDP driver (trusted input), `fill.ts` (page-side
  field set when keystrokes don't land), `evaluate` via `Runtime.evaluate` (CSP-exempt) behind
  `sanitize.ts` (credential-blocking output caps), `inspect.ts` (network/console rings fed at
  debugger attach), `inject.ts` (the one executeScript helper), on-page badge + pulsing
  favicon dot on the driven tab, `restricted-url.ts`, `status-widget.ts`, `action-badge.ts`.
  Background-only. The badge and the pill are injected, so both are best-effort and can be
  absent (PDF, `file://`, CSP, or the `widgetHidden` pref); the toolbar badge is the one run
  signal that never is. Never let the injected marks be the only thing saying a run is alive.
- `providers/` — OpenAI/Anthropic/Responses adapters, presets, pricing (spend estimates —
  `pricing.ts`, see docs/agent/providers.md), storage, config UI. Adding a
  provider is a data change in `presets.ts` — never a code change elsewhere. **The engine
  (provider · model · effort) belongs to the conversation, not to the app**: `engine.ts` holds
  the one rule — the conversation's pin, else the stored pick (`active-provider` + the
  `model`/`reasoningEffort` on the config), else the first configured — and everything asks it,
  the run through `getProviderFor`, the panel through `useEngine`. What is pinned is the PICK,
  so an absent model still means auto; a pin naming a deleted provider degrades to the stored
  pick and the next run re-pins. Changing the picker writes through to the stored default —
  ⌥ (the composer picker and the slash menu alike) scopes the change to this chat instead.
- `conversation/` — stored conversations, message types, chat UI. A conversation owns the
  engine it runs on (`ConversationMeta.engine`, pinned at its first run) — so a picker change
  this afternoon cannot re-point the 9am schedule, and a reopened chat still runs what it
  always ran, and every window's panel is on that same conversation (the panel follows the
  shared `active-conversation` slot). The worker owns transcript
  persistence (`TranscriptWriter`); the panel store only renders. Whenever a run ends without
  a summary of its own — an error, or a user stop — the writer appends a deterministic progress
  note (`progress-note.ts`), so the work still reaches the next run's history. That note is
  `internal`: written for the model, never drawn in the chat — a user stop shows one quiet
  seam line instead. `/compact` (see `agent/compact.ts`) appends a `summary` message instead
  of deleting anything: replay starts at it, scrollback keeps every message.
- `memory/` — the two storage-backed markdown docs every run loads, mirroring the AGENTS.md /
  MEMORY.md convention: `AGENTS.md` is the user's standing instructions, `MEMORY.md` is the
  agent's, written by the `remember` tool. Both share one scope axis (`lib/host.ts`): a
  `## site: <host>` section loads only when the run starts on that site — suffix match,
  www-stripped, no paths — and everything else is global, including the user's own `##` headings.
  The model picks a fact's scope (the `site` param on `remember`); eviction caps each scope
  separately, so one chatty site can't evict another's facts. On by default (`memoryEnabled`);
  off stops both halves and the tool is not offered to the model at all. After a run,
  `extractAndRemember` distills durable facts from the transcript — capped at 3, "none" is the
  expected answer, and facts are tagged with the site they belong to. Edited on the options page
  (no filesystem in an extension — the filenames are the mental model, not a path).
- `mcp/` — the MCP client half: TabRunner dials OUT to remote Streamable HTTP servers and offers
  their tools to its own model (`bridge/` is the server half — external clients dial IN). Sessions
  are lazy — opened during run start alongside tab resolution, closed in start-run's OUTER finally
  (the early provider/target returns never reach the inner one); nothing lives between runs.
  Tools resolve once per run into the tool array (prompt-cache invariant), namespaced
  `mcp__<server>__<tool>` and gated wholesale behind plan approval — remote annotations are
  self-reported. Catalog budgets (per-tool + total description chars) drop whole tools
  deterministically; a dead server costs one connect timeout, zero tools, one neutral step row —
  never a throw. Elicitation/create is honored: panel owners park it like the plan gate,
  bridge/schedule owners decline; roots/sampling are undeclared and answered -32601.
  Background-safe except `ui/`.
- `hooks/` — lifecycle webhooks: user rules that POST run events (run_started, run_finished,
  ask_user, error) to their own URL. Fire-and-forget by contract; deliveries join the memory
  keepalive window instead of arming anything new, failures stamp a per-rule receipt for the
  Settings row and stay quiet. Background-safe except `ui/`.
- `schedule/` — unattended runs on a timer: one-shot, daily, or every-N-minutes with an optional
  weekday filter and active-hours window. Wall-clock rules recomputed after every fire (never
  `periodInMinutes` — it can't hold 9am across a DST shift), one `chrome.alarms` one-shot per
  record, storage re-armed at boot because alarms don't survive every extension update. Fires
  through `submitRun` as a third `RunOwner`, so a scheduled run is just another caller of the one
  run slot; its plan auto-approves because the user approved the schedule's creation. One
  conversation per schedule, so a recurring run can read what it did last time. `recurrence.ts` is
  pure and holds the whole calendar; `scheduler.ts` is the only file that reaches into the agent,
  which is why the barrel stops short of it. Background-only except `ui/`.
- `skills/` — named instruction recipes, importable and site-scoped: the storage is structured
  records (`store.ts`, one capped array, the schedule store's shape); SKILL.md markdown is only
  the interchange form (`skill-md.ts` — imports, pastes, drafts and exports all pass the one
  parser, unknown frontmatter keys reported, never fatal; optional `mcp_servers:` carries MCP
  server refs that install only by explicit opt-in at import — one-way copy into the mcp
  registry, collisions skip). A run snapshots them once at start (`loadSkillsForRun`): the
  system prompt lists applicable skills one line each (scoped via `lib/host.ts`; unsited =
  everywhere), and the read-only `skill` tool returns a body on demand — bodies are never
  auto-injected, and the tool is offered only when enabled skills exist, resolving any of them
  by name so an explicit `/skill <name>` works cross-site. Landing on a new host mid-run
  announces its scoped skills as a `new_skills` key on that navigation's own tool result — the
  per-run tool array never rebuilds. Every enabled skill is also its own slash command
  (`command-names.ts` reserves built-ins' names); `/skills` opens the library whole in a modal;
  `/skill new` distills the open conversation into an editable draft (`distill.ts`, the fourth
  transcript distillation, panel-context). Import takes a URL, GitHub `owner/repo` shorthand
  (repo-shaped inputs scan the repo's tree and offer multi-import), or pasted markdown —
  fetched from the page context, https-only, size-capped, always previewed before saving
  (untrusted prose headed for the system prompt). The model itself stocks the library through
  `save_skill` (`save-skill-tool.ts`, the same pipeline) — ask-first like paying, never
  overwriting an existing name. One built-in ships with the binary
  (`builtin.ts`, `tabrunner-help`) — seeded on install, refreshed on update, deletion sticks.
  Background-only except `ui/`.
- `walkthrough/` — walkthroughs: "do X and document it" turns the task into a shareable
  step-by-step guide. The model arms it with the `document` tool (offered only while
  `walkthroughsEnabled`, the `buildToolDefs` gate); ungated bookkeeping, since capture changes
  nothing on the page. Frames come from `Page.captureScreenshot` over the session the run already
  holds — **never `startScreencast`**, which stalls on a hidden tab and so records nothing exactly
  when TabRunner runs most; the recorder never attaches on its own, so the debugger infobar can't
  precede plan approval (frame 0 falls back to `captureVisibleTab`). Capture is awaited on both
  sides of the tool call: `onStepStart` is sync and a turn's calls run back-to-back, so a
  fire-and-forget shot would land mid-click on the next action. Element actions get the frame
  before, navigations the one after; `finalize()` runs in `start-run.ts`'s one `finally` **before**
  `detachAll()`, so every ending — done, stop, error, closed tab — leaves an artifact. Frames are
  Blobs in IndexedDB (`store.ts`, the codebase's only binary store, GC'd with their conversation);
  they never enter `messages[]`, so a recording structurally cannot reach a provider. Everything
  less than the whole truth is disclosed in the doc's own intro — partial, truncated, armed late,
  frames missed. Background-safe except `ui/`; `recorder.ts` is deliberately out of the barrel
  (it reaches into CDP, and the barrel is imported by pages and by background).
- `bridge/` — the MCP bridge's extension half — clients dial IN through the daemon. The outbound
  twin is `mcp/`. Background-only.
- `tips/` — the rotating "Tip: …" line; i18n data + cooldown scheduler (panel opens,
  least-recently-shown wins, re-picked on panel open / run end). Shows in the running run
  band, or above the composer card when idle — and yields whenever the zone is already
  full (queued cards, attachments, a paste hint), so a crowded footer never carries one.
  Shipping a user-facing gesture, shortcut, or tucked-away control?
  Add a tip with it: id + cooldown in `registry.ts`, copy in all three `tips.*` catalogs. Keep the
  copy short — one idea, ≤ ~90 chars; `TipLine` clamps at two lines, so a tip that needs more is
  two tips.
- `shared/` — Port protocol, shared types, brand mark (`logo.ts`).
- `src/components/` — cross-domain Base UI primitives (Button, Select, TextField, dialogs…)
  plus the chat Bubble/MessageScroller shells over `@shadcn/react`.
- `src/i18n/` — the one i18next instance, the `en`/`pt-BR`/`es` catalogs, and typed keys.
  Not a `modules/` domain because every layer needs it, background included.
- `src/lib/` — storage helpers, logger, Tailwind theme tokens (`brand-*` comet-burn emerald scale,
  indigo-tinted neutrals; the `telemetry` utility = gold, for anything that
  measures — elapsed, tokens, the plan step in flight. Gold measures at rest:
  a number ticking mid-stream (the live band's clock, a burst's elapsed) runs
  neutral. Emerald acts, gold measures; never pick an `amber-*` shade by hand
  for a measurement.

### Data flow

| Channel                         | What                                         | Why                                                |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| `wxt/utils/storage` + `watch()` | Settings, provider configs, conversations    | Cross-context pub/sub, zero messaging code         |
| Port (`runtime.connect`)        | Token deltas, step events, run/stop commands | Streaming; an open Port keeps the MV3 worker alive |

Chrome draws **one side panel per window**, each its own document with its own store and
its own Port, so a run's events are broadcast to every open panel, stamped with the
conversation they are about (`PanelMessage` in `shared/protocol.ts`). Every panel showing
the thread is a live subscriber — identical events in, identical state out; one showing
another thread drops the stamp, and an unstamped message is a reply to that panel's own
command. A panel that did not dispatch the run **adopts** the stream (panel-owned runs
only: a schedule or bridge run sends a panel nothing and follows through the transcript
refetch, which adopting would switch off). What stays per-window is what belongs to the
window: the composer draft, `lastRun` — which is how "did THIS panel dispatch the run in
flight" gets answered, and therefore which one auto-closes on walk-away — and scroll.

Conversations: a `conversations` metadata index + one `conversation:<id>` key per transcript;
writes are serialized on one promise chain; the transcript is the model's per-conversation
memory (`buildConversationHistory`); the `read_history` tool pages the full transcript mid-run.
Tabs belong to messages, not to the conversation. Retention is two-tier (`pruneTranscript`): the
newest `RECENT_WINDOW` messages survive whole — the crash window, every step row and thought —
and above it only the spine, the conversation's own turns, up to `MAX_MESSAGES`. So anything that
must outlive its own run belongs on a spine role or on `ConversationMeta`, never on a step row.

## Deep-dive docs

These carry the full rationale and invariants — read the one for the area you're touching:

- [docs/agent/architecture.md](docs/agent/architecture.md) — module internals: run lifecycle,
  plan gate, ask_user, status widget, OAuth/sign-in, conversation storage, tabs-per-message.
- [docs/agent/bridge.md](docs/agent/bridge.md) — MCP bridge internals: WS direction, run queue,
  compact events, daemon mirror, dual protocol declaration, MV3 timing, direct control.
- [docs/agent/providers.md](docs/agent/providers.md) — provider wire contracts: tool-result
  shapes, auth headers, reasoning effort, image/screenshot handling, body pruning, model lists.
- [docs/mcp.md](docs/mcp.md) — human-facing MCP setup docs.
- [docs/roadmap.md](docs/roadmap.md) — what's next and why, open design questions, and the
  things we've deliberately ruled out. Forward-looking; the docs above are as-built.

Quick invariants that bite often:

- **Protocol declared twice on purpose**: `src/modules/bridge/protocol.ts` (source of truth) and
  `daemon/src/protocol.ts`. Change them together, then `bun run bridge:check`.
- **Stop is not an error**: user abort ends a run with `done`, never a red bubble.
- **No sampling params** (temperature/topP) on any provider — the only knob is `reasoningEffort`.
- **A question in plain prose does not pause a run** — only the `ask_user` tool does.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — `import type` for
  type-only imports (ESLint-enforced).
- No `any` in production code (ESLint-enforced). Fix the underlying type mismatch instead.
- No deprecated aliases or compatibility shims — clean breaks, fix the real problem.
- Prettier: 2-space, double quotes, semicolons, width 100.
- `@/*` alias → `src/*` (via `srcDir: "src"` in wxt.config.ts — WXT owns the `@` default).
- Base UI for interactive primitives — go through `src/components/`, don't hand-roll buttons,
  selects, inputs, or dialogs.
- i18n: no user-visible string is a literal — `useTranslation()` in UI, `i18n.t` elsewhere
  (`src/i18n` is React-free so the service worker translates too). Keys are typed off `en.json`,
  so a missing key is a compile error; add to **all three** catalogs in the same edit and run
  `i18n:check`. The panel's UI entrypoints must `await initUiI18n()` **before** `render` —
  `useTranslation` suspends forever on an uninitialized instance, which renders a blank panel.
  Extension metadata (name, description, action tooltip) is separate: `public/_locales/<lang>/`
  - `__MSG_*__` in `wxt.config.ts`, and Chrome wants `pt_BR`, not `pt-BR`.
- Theming: class-strategy dark mode (`@custom-variant dark` in `src/lib/theme.css`) — every color
  utility needs a `dark:` counterpart. The preference lives in `src/lib/theme.ts` (`themeMode`
  item, default `"system"`; `initTheme()` runs once per entrypoint, before render).
- Every error and empty state must orient and offer a way forward — Problem · Cause · Fix for
  errors; Purpose · Content · Action for empty states. Never a raw error or a bare "no results".
  Raw JSON error bodies go behind a Details disclosure (`splitErrorDetail` in
  `conversation/error-detail.ts`).
- Log via scoped loggers (`createLogger("<scope>")` from `src/lib/logger.ts`) — never raw
  `console.*`. Lifecycle at `info` (Chrome hides `debug` unless Verbose is on), chatter at
  `debug`. Never log API keys or page content; bound long strings with `truncate()`.
- Non-trivial logic leaves one runnable check behind (a small vitest file — no frameworks, no
  fixtures).
- Brand assets are generated: edit `src/shared/logo.ts`, run `bun run icons`. Never hand-edit
  `public/icon/*`.
