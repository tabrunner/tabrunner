---
name: tabrunner.app
description: Marketing/download site for TabRunner — an AI agent that drives your real browser. Tabs are comets.
colors:
  field-ground: "#070b16"
  field-deep: "#04060d"
  field-panel: "#0b1224"
  field-border: "#25325c"
  flare: "#10b981"
  flare-bright: "#34d399"
  flare-pale: "#6ee7b7"
  telemetry: "#fbbf24"
  telemetry-dim: "#fcd34d"
  starlight: "#e8eefb"
  star-dim: "#b9c6de"
  star-faint: "#8797ba"
typography:
  display:
    fontFamily: "Unbounded Variable, Figtree Variable, system-ui, sans-serif"
    fontSize: "clamp(2.1rem, 4.8vw, 3.6rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Figtree Variable, system-ui, sans-serif"
    fontSize: "1.125rem"
    lineHeight: 1.6
  telemetry:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontFeature: "tnum"
  telemetry-sm:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontFeature: "tnum"
  telemetry-xs:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.625rem"
    letterSpacing: "0.05em"
rounded:
  panel: "16px"
  control: "12px"
  chip: "6px"
  focus: "4px"
  pill: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.flare}"
    textColor: "{colors.field-deep}"
    rounded: "{rounded.pill}"
    padding: "12px 24px"
  button-primary-hover:
    backgroundColor: "{colors.flare-bright}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.starlight}"
    rounded: "{rounded.pill}"
    padding: "12px 24px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.star-dim}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.field-panel}"
    textColor: "{colors.starlight}"
    rounded: "{rounded.panel}"
    padding: "24px"
  input-mission:
    backgroundColor: "{colors.field-panel}"
    textColor: "{colors.starlight}"
    rounded: "{rounded.panel}"
    padding: "8px"
---

# Design System: tabrunner.app

## Overview

**Creative North Star: "The Comet Field"**

The browser's tab strip is a night sky, and every task launches a comet: a tab in motion with an
emerald burn trail behind it — the green a comet burns on entry. The site is the mission-control
room for that sky — dark, quiet, instrumented — where a visitor watches one run happen and
believes it. The category default (a glowing orb over a bento grid of icon cards, everything
purple, copy that says "revolutionary") is refused in full.

Density is low and cinematic up top, tightening into instrument panels (the run console, the
install flight plan) as the visitor descends. Motion is the material: comets cross the fixed
canvas field, telemetry ticks, and the one authored moment is a task launching a comet from the
hero's mission line. Everything decorative must be a comet, a star, a trail, or an instrument —
nothing else earns a place.

**The One Moment Rule.** The comet launch is the page's authored motion; the canvas and the run
console are ambient instruments that were always running. Sections do not animate in. A uniform
scroll-reveal on every heading is the opposite of one authored moment — and it makes content
that is invisible until observed, which no static capture, print, or non-scrolling reader ever
sees. Content is visible at rest, always.

**Key Characteristics:**

- Deep-field indigo ground, never pure black; stars and comet trails carry the light.
- Burn emerald is the comet's tail — the color of _motion_, not of decoration.
- Telemetry amber measures: timers, token counters, live pulses. Amber means "the agent is working."
- Browser chrome is compositional material: the sticky top bar is a chrome bar (favicon, omnibox,
  actions); the screenshot viewer sits inside a browser frame; the brand mark is a tab in flight.
- Type does three jobs only — Unbounded speaks (display), Figtree explains (body), JetBrains Mono
  measures (telemetry). Nothing else earns a typeface.

## Colors

Drenched dark: the surface IS the night sky; emerald and amber are light sources inside it.

### Primary

- **Flare** (`#10b981`): comet trails, primary actions, links, active states. The color of things
  that move. Bright (`#34d399`) for hover and near-head trail; pale (`#6ee7b7`) for shimmer peaks.
  Fills take field-deep ink — flare-500 carries it at ~6:1.

### Secondary

- **Telemetry** (`#fbbf24`, dim `#fcd34d`): elapsed timers, token counts, the live pulse dot,
  "working" status verbs. Never decorative — if it's amber, it's measuring something.

### Neutral

- **Field Ground** (`#070b16`): page sky. **Field Deep** (`#04060d`): text on flare buttons, canvas
  backdrop. **Field Panel** (`#0b1224`): instrument glass. **Field Border** (`#25325c`): hairlines.
- **Starlight** (`#e8eefb`): primary text. **Star Dim** (`#b9c6de`): secondary text.
  **Star Faint** (`#8797ba`): captions, placeholders — tinted from the sky, never pure gray.

### Named Rules

**The Two Lights Rule.** Only two hues emit light on this page: emerald (motion) and amber
(measurement). Any third saturated hue is a bug, not a flourish. The one sanctioned exception is
the launched comet's heat: a bright comet's youngest trail segments burn amber for their first
~0.18s before cooling to emerald — that is the comet igniting inside the page's one authored
moment, not a measurement.

**The No-Purple Rule.** The retired royal-purple brand (`#8b5cf6` family) must not appear in new
work; the cyan that briefly replaced it (2026-08, first pass) is retired with it. Both survive
only in git history.

## Typography

**Display Font:** Unbounded (variable) — wide, rounded, cosmic; the comet's voice.
**Body Font:** Figtree (variable) — quiet geometric grotesk that explains without competing.
**Label/Mono Font:** JetBrains Mono (variable, tabular numerals for ticking values).

### Hierarchy

- **Display** (600, `clamp(2.1rem, 4.8vw, 3.6rem)`, 1.08, −0.02em): hero statement (two block
  lines, second in flare) and section headings (`text-3xl`–`4xl`).
- **Body** (400–500, 1–1.125rem, measure ≤62ch): explanatory copy.
- **Telemetry** (mono, three steps only — `text-[10px]` badges and frame chrome, `text-[11px]`
  plan and diagram captions, `text-xs`/`text-sm` timers and tool lines; uppercase tracking for
  labels, `tnum` for values): timers, counters, commands, status lines, badges.

### Named Rules

**The Measurement Rule.** Monospace is data: time, tokens, commands, URLs, key names — plus
entity labels in chip/label positions (browser names, provider names, version-free statuses),
the instrument-panel idiom. Running prose never wears mono.

## Layout

Full-bleed fixed canvas sky; content on one centered column (`max-w-6xl`, `px-4/6`) floating over
it. Sections alternate density: cinematic sparse (hero, privacy) against instrument-dense (run
console, flight plan). `py-24` section rhythm; more space above a heading than below it. Grid
children carry `min-w-0` — `text-balance` inflates intrinsic sizes and will burst a mobile track
without it. Mobile stacks: hero becomes headline → mission line → CTAs → console.

## Elevation & Depth

Depth is atmospheric: translucent field-panel fills over the sky, hairline field-border strokes,
and a soft emerald glow only around things that are _alive_ — the run console, the primary CTA,
the selected screenshot. No drop-shadow stacking, no offset block shadows.

### Named Rules

**The Glow-Means-Live Rule.** A glow asserts activity. Static content sits flat on the sky; only
running things (or the one action we want taken) may glow.

## Shapes

- The **comet-tab**: a browser-tab silhouette (rounded top corners, flat bottom) with an emerald
  favicon dot and two speed trails — the brand mark, recurring from favicon to canvas comet heads
  to the screenshot frame's tab. Authored SVG, one geometry, comet-burn palette.
- Panels/cards: gently curved instrument glass (16px). Controls 12px. Pills for buttons, chips,
  status badges.

## Components

### Buttons

- **Shape:** pill (9999px).
- **Primary:** flare background, field-deep text, 12/24 padding, soft emerald glow (the
  Glow-Means-Live exception: it is the action we want taken). Hover brightens to flare-bright and
  lifts the glow.
- **Ghost:** transparent, field-border stroke, starlight text; hover strokes flare and tints text.

### Cards / Containers

- 16px radius, field-panel fill at 60–70% opacity over the sky, hairline field-border, no shadow
  at rest. The live run console adds the emerald aura and a pulsing amber dot.

### Inputs / Fields

- The **mission line**: 16px panel with inner padding, focus-within strokes flare; the submit
  control is a field-600 tile with mono label. Placeholder rotates through real example tasks.

### Navigation

- The page's own browser chrome: comet-tab favicon + wordmark left, omnibox pill
  (`tabrunner.app`, mono, lock glyph) center, text links + EN/PT/ES segmented switcher + primary
  Download right. Sticky, backdrop-blurred field-ground.
- Below `md` the omnibox and section links stand down and the actions cluster pins to the right
  edge — the bar keeps its two anchors, brand and action, at the two margins. The wordmark stays:
  a 26px mark alone is not a brand.
- Below `sm` the EN/PT/ES switcher leaves the bar too, and the footer carries it (44px targets).
  Wordmark, switcher and the store button need 423px, so on a 390px phone the bar scrolled
  sideways. The language already follows the browser, so the switcher is an override, and an
  override belongs at the foot of the page, not beside the action we want taken. Check the bar at
  320, 360, 390 and 430px in all three languages: Portuguese is the longest.

- Off the home page (Docs) the section links lead to that section of the home page, in the
  reader's language, and the omnibox pill shows the page's own address (`tabrunner.app/docs`).

### Command blocks

- A command to paste, on the docs page: field-panel fill, hairline field-border, 12px radius,
  mono at 12/14px. It wraps instead of scrolling, so the whole command can be read before it is
  pasted into a terminal. A pill Copy button answers at once ("Copied" for 1.5s); if the browser
  refuses the clipboard, it selects the command instead. Commands are data and are never translated.

### Focus

- One flare ring for every focusable thing: `2px` solid flare-bright at `2px` offset, on
  `:focus-visible` only. A skip link is the first focusable element on the page.

### Run Console (signature)

Simulated agent run, labelled "simulated demo": task header with live amber pulse, plan with
check/active/pending steps (authored SVG marks, never `✓`/`▸` glyphs), mono tool-call lines,
shimmer on the working verb, amber telemetry footer (elapsed, tokens). One clock derives every
state, the run reads as planning until the plan exists, and the token count lands on its total
exactly as the run finishes. Reduced motion shows the finished run.

## Do's and Don'ts

### Do:

- **Do** make the sky respond: the mission line launches a comet; the pointer leaves a flare wake.
- **Do** show the product working: a labelled simulated run, real screenshots in a chrome frame.
- **Do** state hard truths in plain view: Chromium-only, sideload caveats, no server.
- **Do** keep telemetry in tabular numerals so ticking values never jitter.
- **Do** hold 4.5:1 contrast on the sky — secondary text is star-dim, never darker.

### Don't:

- **Don't** use the retired purple, gradient text, or glass blur as decoration.
- **Don't** invent proof: no testimonials, customer logos, download counts, or star counts.
- **Don't** offer dead download buttons for Firefox/Safari — say Chromium-only in words.
- **Don't** let any element glow that isn't live or the primary action.
- **Don't** use emoji or unicode glyphs as icons; icons are authored SVG in one stroke weight.
- **Don't** hardcode a version number anywhere — downloads are `releases/latest` aliases only.

## Landing

The landing page (`/`, `src/App.tsx`). Mode: Persuade. The visitor is an AI power user or a
developer. The page works when they get it in seconds, trust it, and install from the Chrome Web
Store. The direction contract sits in the opening comment of `src/App.tsx`.

Spine: the route a goal travels from you to the page, drawn as a metro map with one station per feature.
Driver: the visitor's own mission line. Submitting it starts the page's one animation; everything else stays still.
Motion: a comet-tab launches across the sky with an amber nucleus flash, over a fixed comet-field canvas.

The direction is "The Comet Field": browser chrome used as the page's material, a dark cosmic
feel, and the comet-ice palette (it replaced the retired royal purple).

- First screen: a nav drawn as browser chrome; the two-block Unbounded headline ("You give the
  goal. / It runs the tabs."); a mission line that launches a comet on submit; the main button,
  _Add to <their browser>_, to the store listing (live since 2026-08-15); browser chips; a
  simulated live run console on the right; the comet-field canvas fixed behind everything.
- The Route: the features as stations on a signal-path schematic (you or MCP, the extension hub,
  a ghost "relay server" spur, the provider, the guardrails gate, the page), each with its
  evidence beside it. It replaced the 2026-08 icon-card constellation, which a review flagged as
  the category default. The Route is an instrument at rest (no glow, no motion), so the launch
  stays the one authored moment.
- After it: real screenshots in a browser frame with a thumbnail switcher; the install "flight
  plan" in three stages (add from the store, pin and open the panel, pick a provider), with plain
  caveats and a fold-down developer-mode zip path; the "No ground station" privacy data map; the
  footer.
- Languages: en-US, pt-BR and es-ES. The browser's language is the default, `?lang=` overrides
  it, localStorage keeps the choice, and the switcher sits in the nav.
- Constraints: never hardcode a version (latest-alias URLs only, see `src/lib/links.ts`); state
  the permission and provider caveats and the Chromium-only limit plainly; link the store
  listing, never a CRX (there is no publisher proof: CRX_REQUIRED_PROOF_MISSING) and never the
  store's blob URL; no invented proof; screenshots come from `../chrome` through `bun run sync`.

The other ideas behind this page were not written down; only the pick was.

Open: the product screenshots predate the rename ("Regent"/"Regentry", old purple, crown mark)
and need retaking against the current build. Until then the site labels them as the old brand.
The extension redesign will take this palette and the comet-tab mark (geometry in
`src/components/CometMark.tsx`). The Cloudflare Pages project name in
`.github/workflows/deploy.yml` may need to match the real dashboard project.
