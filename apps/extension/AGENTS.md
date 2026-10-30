# TabRunner extension

Provider-agnostic Chromium extension. The model drives the user's existing browser sessions.
Read the root [workspace guide](../../AGENTS.md) for shared commands and release rules.

## Commands

Run these from apps/extension after installing once at the repository root:

```bash
bun run dev        # hot reload
bun run build      # production build into dist/chrome-mv3
bun run typecheck  # extension types only
bun run lint       # extension source and scripts
bun run i18n:check # locale parity and static translation keys
bun run icons      # extension icons, root docs/og.png and plugin icons
bun run shots      # root docs/screenshots plus site WebP derivatives
bun run shots:ui   # local UI previews
bun run bench:jev  # live Jev checks, requires JEV_API_KEY and credits
bun run zip        # dist/tabrunner-<version>-chrome.zip
```

Load dist/chrome-mv3 through chrome://extensions. Before submitting, run scoped lint/typecheck,
build and i18n checks. Run only a test file you wrote or changed; never the full suite by default.
Dead-code, formatting, bridge and release commands belong to the repository root.

## Releasing

The version in this package's package.json is the release source of truth. Keep the package name
`tabrunner`: WXT derives the public ZIP filename from it. The manifest's public key keeps every
unpacked build on the Chrome Web Store listing's extension ID.

Run `bun run release minor` from the repository root. It checks extension/MCP types and lint,
bumps the extension, daemon and plugin together, commits, tags and builds both artifacts. It never
pushes. The root [release workflow](../../.github/workflows/release.yml) publishes a pushed v* tag.
Root NPM_TOKEN and MCP_REGISTRY_KEY secrets publish the daemon and its registry entry.

One ZIP serves every channel. Publishing and the Chrome Web Store upload are Gus's routine; never
list that upload as an outstanding handoff step. CRX distribution is retired.

The [website contract](../../docs/website-brief.md) and apps/site must change together when a product
claim or screenshot changes. Public architecture docs stay in the root docs/ directory.

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

- `agent/`: agent loop, tools, system prompt, run registry + per-owner FIFO queue, run start.
  At most four tasks run across panel, bridge and schedule owners. Each owner and conversation
  has at most one live task; all panel runs share ownerId `panel`, so the panel stays serial.
  Stop aborts without releasing: actions, external reads and browser cleanup finish before the
  run leaves the registry. A panel run **adopts the user's current tab on the thread's first
  message**: it drives the page as-is (the plan
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
- `browser/`: accessibility-tree snapshot, CDP driver (trusted input), per-run tab claims,
  `fill.ts` (page-side field set when keystrokes don't land), `evaluate` via `Runtime.evaluate`
  (CSP-exempt) behind
  `sanitize.ts` (credential-blocking output caps), `inspect.ts` (network/console rings fed at
  debugger attach), `inject.ts` (the one executeScript helper), on-page badge + pulsing
  favicon dot on the driven tab, `restricted-url.ts`, `status-widget.ts`, `action-badge.ts`.
  Background-only. Drivers use the run id as `ownerId`; CDP helpers name their tab explicitly.
  Claim a tab before any page work or marks, and release only that owner's resources. Separate
  tabs still share the browser profile's cookies and account state. The badge and the pill are
  injected, so both are best-effort and can be
  absent (PDF, `file://`, CSP, or the `widgetHidden` pref); the toolbar badge is the one run
  signal that never is. Never let the injected marks be the only thing saying a run is alive.
- `providers/` — OpenAI/Anthropic/Responses adapters, presets, pricing (spend estimates —
  `pricing.ts`, see docs/agent/providers.md), storage, config UI. Adding a
  **keyed** provider is a data change in `presets.ts` and nothing else — its wire quirks
  ride on preset fields (`headers`, `inlineToolImages`, `supportsImages`, `effortDialect`,
  `explicitNone`), never on an adapter branch. A **signed-in** one is a `createAuthFlow` id from
  `@providerkit/core/auth` (plus its `auth: "oauth"` preset) and one line in `CORE_FLOW` in
  `oauth-flows.ts`; Claude is the one flow kept here (`claude-oauth.ts`). That map is the
  whole seam, and it is what stops a provider being signable but not refreshable.
  **The vendor-neutral half lives in [`@providerkit/core`](https://providerkit.dev)** — error
  classification (`classifyHttp`, `isTransportFailure`), tool-argument salvage
  (`parseToolArgs`), rate-limit window parsing, SSE framing (`parseSseStream`), `apiUrl`.
  Do not re-add any of them here. What stays is what the package cannot know: the translated
  error envelope, the warn-vs-error log split, `formatResetRelative`, and `context-window.ts`,
  which learns the real ceiling from a length rejection instead of guessing from a model name. **The engine
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
- `jev/` — the Jev executor. With a Jev key saved (Settings → Providers; saving turns it on, the
  panel menu's switch turns it off), the model gets a gated `delegate` tool that hands a routine
  stretch of clicking and typing on the current site to Jev, a classifier billed per input token.
  `executor.ts` loops observe → one batched Choice request → guard → act → settle against an
  `ExecutorPage` (the driver in production, fakes in tests, puppeteer in the bench), and every
  exit is a named stop the planner hears — caps on actions, decisions and time, no change, a
  repeated dead step, unstable reads, low confidence, a new tab, leaving the site, a restricted
  url — never a loop. Before any CLICK or ENTER, `guard.ts` asks one yes/no "does this commit the
  user?"; YES ≥ 0.5 hands back, and the planner takes that step after `ask_user`. Sensitive fields
  and file pickers are never offered. The wire to the five hosts (OpenCode Zen, TypeSafe,
  OpenRouter, Cloudflare, Vercel) is `@providerkit/core/decisions`; `hosts.ts` keeps only labels,
  links, the rate, OpenRouter's decision-model catalog, and OpenRouter's balance. Cost reaches the
  run as `onUsage({ input: 0, output: 0, cost })`, so the context gauge stays the planner's.
  Background-safe except `ui/`.
- `schedule/` — unattended runs on a timer: one-shot, daily, or every-N-minutes with an optional
  weekday filter and active-hours window. Wall-clock rules recomputed after every fire (never
  `periodInMinutes` — it can't hold 9am across a DST shift), one `chrome.alarms` one-shot per
  record, storage re-armed at boot because alarms don't survive every extension update. Fires
  through `submitRun` with the schedule id as `ownerId`, sharing the four-task limit while
  keeping each schedule serial. Its plan auto-approves because the user approved the schedule's
  creation. One conversation per schedule, so a recurring run can read what it did last time.
  `recurrence.ts` is
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
  before, navigations the one after; `finalize()` runs before `releaseBrowserOwner(run.id)`,
  so done, stop, error and closed-tab endings all leave an artifact. Frames are
  Blobs in IndexedDB (`store.ts`, the codebase's only binary store, GC'd with their conversation);
  they never enter `messages[]`, so a recording structurally cannot reach a provider. Everything
  less than the whole truth is disclosed in the doc's own intro — partial, truncated, armed late,
  frames missed. Background-safe except `ui/`; `recorder.ts` is deliberately out of the barrel
  (it reaches into CDP, and the barrel is imported by pages and by background).
- `bridge/`: the MCP bridge's extension half. `../../packages/mcp/` elects one shared local broker;
  each stdio client gets a fresh session id. `BridgeClient` owns that session's stored conversation,
  delegated/direct work, controls, compact status and screenshots. Direct and delegated tasks
  continue the same per-client thread; a worker restart preserves its id, but a new MCP session
  starts fresh. Client commands serialize independently. Requests/events carry client and run ids;
  stale controls cannot reach newer work. Broker heartbeats renew a 60s owner lease, reconnects
  resync each client without replaying browser actions, and close/expiry drains only that owner's
  work. Protocol v2 rejects mismatches. The outbound twin is `mcp/`. Background-only.
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

- [docs/agent/architecture.md](../../docs/agent/architecture.md) — module internals: run lifecycle,
  plan gate, ask_user, status widget, OAuth/sign-in, conversation storage, tabs-per-message.
- [docs/agent/bridge.md](../../docs/agent/bridge.md) — MCP bridge internals: WS direction, run queue,
  compact events, daemon mirror, dual protocol declaration, MV3 timing, direct control.
- [docs/agent/providers.md](../../docs/agent/providers.md) — provider wire contracts: tool-result
  shapes, auth headers, reasoning effort, image/screenshot handling, body pruning, model lists.
- [docs/mcp.md](../../docs/mcp.md) — human-facing MCP setup docs.
- [docs/roadmap.md](../../docs/roadmap.md) — what's next and why, open design questions, and the
  things we've deliberately ruled out. Forward-looking; the docs above are as-built.

Quick invariants that bite often:

- **Protocol declared twice on purpose**: `src/modules/bridge/protocol.ts` (source of truth) and
  `../../packages/mcp/src/protocol.ts`. Change them together, then `bun run bridge:check`.
- **No `chrome.debugger` listener at module scope**: WXT imports the background entrypoint at
  build time under a fake browser whose `debugger.onEvent`/`onDetach` throw on `addListener`, and
  whether a given module is reached depends on how that analysis bundle tree-shakes — so one sits
  dormant until an unrelated import change takes the build down. Register at attach
  (`wireSession` in `cdp-driver.ts`); `browser/__tests__/module-scope.test.ts` holds the line.
- **The side panel's first load is the shell, never the app**: Chromium keeps an extension side
  panel hidden until its document's first load finishes, and a hidden renderer runs at background
  priority. `sidepanel/shell.ts` imports nothing (ESLint-enforced) and `import()`s the app after
  `load`. Put app code back on that load and a busy machine shows minutes of empty gray. The
  boot log's `shown` stamp is the check.
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
