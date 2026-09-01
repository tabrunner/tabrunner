# Roadmap

Not a promise — a record of what we think is next and, more usefully, _why_, so a decision made
once doesn't get re-litigated from scratch six weeks later. Items graduate out of here into
`docs/agent/*.md` (as-built) when they ship.

## The bet

Everything below is judged against one question: **does it compound the thing a sandboxed agent
structurally cannot copy?**

Operator, computer-use-in-a-VM, and the Browserbase-shaped products all drive _a_ browser. They
cannot drive _yours_ — your cookies, your SSO, your 2FA'd bank, your work Google account — because
the whole point of their sandbox is that it isn't your machine. TabRunner's moat is that it runs
inside the browser you're already logged into, and (since v0.4.2) keeps running when you're asleep.

So the ranking rule: **a feature that only makes the agent smarter is worth less than a feature
that makes it smarter _about your sites, over time_.** Generic agent-loop improvements are table
stakes we get from the model. Accumulated, site-specific, session-bound competence is ours alone.

That rule is what puts skills at the top and Firefox at the bottom.

---

## Next

### 1. Domain policy — where the agent may and may not go

**Why first:** the pitch is "it drives your real logged-in sessions." Today a user cannot say
_"never touch my bank."_ The plan gate is per-run consent, and the consequential-action rule
(`ask_user` before paying/sending/deleting) lives in the **system prompt** — the model can simply
not follow it. There is no enforced boundary anywhere in the codebase. For a product with this
much access, "trust the model" is not a security model, and it is the first thing a thoughtful
user (or a store reviewer) asks about.

**The mechanism is small. The semantics are the work.**

The cheap version — mirror `isRestrictedUrl` at the three tab-resolution sites in
`start-run.ts:533,558,574` — is about half a day and **leaks immediately**: the agent clicks a
link and is on the blocked domain, because `navigate` is not the only thing that navigates.

So the check belongs at the **act boundary in the driver**, not on the `navigate` tool: before any
action, the driven tab's _current_ URL is the thing that must be allowed. Open decisions:

| Question                       | Leaning                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist or blocklist?        | **Blocklist.** An allowlist is unusable for open-ended browsing, which is the product.                                                                                |
| Wildcards?                     | Registrable domain + subdomains (`*.chase.com`), no path patterns in v1.                                                                                              |
| What happens on a hit mid-run? | Refuse the action and tell the model why, so it can re-plan or `ask_user` — not a hard abort. A blocked page reached mid-task is usually a wrong turn, not an attack. |
| Does it survive adoption?      | Yes — adopting a blocked tab must fail at start, with the reason.                                                                                                     |
| Ship with defaults?            | No. A pre-seeded bank list would be wrong in every locale and reads as security theatre. Empty, with a settings pane and a good empty state.                          |

**Not in scope:** per-tool policy ("read but never click here"). That's a second axis and it can
wait for evidence that anyone wants it.

### 2. Skills — the compounding layer

The one that actually serves the bet. Five tiers, and **we already shipped tier 1 without calling
it that**: `memory/AGENTS.md` is a general, always-loaded skill.

| Tier                        | What                                                                                                       | State                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. **General**              | Always-on standing instructions                                                                            | ✅ `memory/AGENTS.md`                               |
| 2. **Domain-scoped**        | Loads only when the run's tab matches a URL pattern — _"on Gmail, archive is the box icon, not the trash"_ | ✅ `## site:` sections, both docs                   |
| 3. **Commands ("plugins")** | `/expenses` invokes a named recipe, with args                                                              | ✅ `skills/` + `/skill <name>`                      |
| 4. **Learned**              | After a run that took real figuring-out, the agent offers to save what it worked out                       | ⬜ the offer; `/skill new` ships the on-demand half |
| 5. **Waypoints**            | A skill stores _anchors_, not just prose — so run #2 doesn't re-snapshot its way to the same button        | ⬜ the differentiated one                           |

**Tier 2 shipped as the cheapest real step**, with no new storage model: `## site: <host>`
sections on the existing docs, host-suffix matched (no paths, no public-suffix list —
`lib/host.ts`), filtered by `loadAgentContext(url)` at run start. The model scopes writes
(`remember`'s `site` param, and the post-run extraction tags facts), and eviction caps each scope
separately. Now see if anyone's instructions file gets unwieldy, and let that decide whether
tiers 3–5 are real.

**"Site memory" is this same change, seen from the other side — not a third store.** The two
directions are already two documents:

- `AGENTS.md` — what the **user** teaches it. Scoped to a site, that is a domain skill (tier 2).
- `MEMORY.md` — what the **agent** learns. Scoped to a site, that is site memory.

So both are one scope axis on the docs we already ship, and the same `url:` matcher serves them.
Building site memory as its own subsystem would give us two mechanisms for one idea, and a user
with no way to tell which document their fact landed in.

It also fixed something that was broken: `MEMORY.md` was global and capped, so facts about twenty
sites competed for one budget and **every run loaded all of them.** Scoping means a run on Gmail
carries Gmail's facts and not Jira's — better behaviour and a smaller prompt, from the same edit.
That made tier 2 worth doing on the memory side even before the skills side proves out.

**Tier 5 is the one nothing else can build.** A sandboxed agent starts cold on every task, so
site-specific waypoints have nowhere to accumulate. We come back to the same logged-in page every
day — that's a memory only this architecture can hold. Speculative, and named here so it isn't
forgotten.

**Tier 3 shipped as its own store — and the "third store" objection above is why it has the
shape it has.** A skill is what a `## site:` section can't be: named, listed by description,
loaded on demand, invocable with args, portable. So the record is structured (`skills/store.ts`,
one capped array, the schedule store's shape) and SKILL.md markdown is only the interchange form
(`skill-md.ts` parses imports, pastes and drafts; serializes exports) — the cron ruling applied
again. Activation is progressive disclosure, not injection: the system prompt lists applicable
skills one line each (site-scoped by the same `lib/host.ts` matcher; unsited skills always),
and the read-only `skill` tool returns a body when the model wants it — auto-injecting bodies
would recreate the very unwieldy-instructions problem this tier exists to solve. `/skill <name>`
sends a localized task naming the skill, and the tool resolves any enabled skill by name, so an
explicit ask beats the ambient scope. `/skill new` distills the open conversation into a
reviewed, editable draft — tier 4's on-demand half; the unprompted post-run offer stays open.

**Shareable skills shipped with it**, because the interchange form made distribution nearly
free: import by URL, GitHub `owner/repo` shorthand, or paste — full-body preview before saving
is the consent gate for prose that will ride the system prompt — and copy-as-markdown export.
Still open there: a named registry, if users ever trade skills enough to want one.

---

### 3. Watch and repeat — skills authored by demonstration

**Why it ranks this high:** it is the bet, stated as a feature. Everything else on this list makes
the agent better at figuring your site out; this one lets you _show_ it, once, and have it know.
A sandboxed agent cannot be shown anything — it isn't in the room where you work. We are.

The shape: you turn on watching, do the thing yourself, turn it off. TabRunner writes up what it
saw, you correct it, and it becomes a Skill it can run for you from then on. "Watch me file this
expense" is a sentence no competitor's architecture can accept.

**What just shipped is half of it already.** `walkthrough/` (v0.5.2) captures a process as frames
plus captions, stores them, and renders a document. Watch-and-repeat is one new _source_ into that
store (the user's own actions instead of the agent's tool calls) and one new _sink_ out of it (a
Skill draft instead of an HTML file). The store, the caption pipeline, the viewer and the export
are already there.

**The design call that decides whether this works: repeat means a Skill, not a macro.** The
tempting version records selectors and replays them. It is the wrong product and we should not
build it. A recorded click list breaks the first time the page moves a button, and _the whole
reason skills are prose_ is that the model re-derives the actions against a fresh snapshot each
run. So watching produces a recipe in words — "open the expense tool, pick the newest receipt,
match it to the card charge" — and the agent re-solves the page every time. Brittleness is what
macro recorders sell; resilience is what we sell.

**What is genuinely hard about the watch half.** Walkthroughs key every frame off a tool call,
which is what lets a caption say "Click Compose" instead of "click #btn-42". A watched user makes
no tool calls, so that advantage has to be recovered a different way: our own snapshot already
names elements readably, page-side (`browser/snapshot-script.ts`), so a click listener can resolve
`event.target` through the same naming and keep the caption quality. That reuse is the difference
between this and a DOM-diffing recorder.

Two constraints to design against, both real:

- **No debugger.** Watching must not attach CDP — the "debugging this browser" infobar would sit
  over the user's own work for the entire session, and we are not dispatching input, only
  observing. That means a content script plus `chrome.tabs.captureVisibleTab`, which is also the
  no-attach path frame 0 already uses.
- **`captureVisibleTab` is rate-limited** (~2/sec), while human actions arrive in bursts — a form
  fill is six events in two seconds. So the watcher has to coalesce events into _steps_ before it
  captures, rather than shooting per event. That coalescing is the interesting engineering, and it
  is also what keeps the write-up readable.

**Privacy is sharper here than anywhere else in the product.** This records the user's own
keystrokes on their own sites — password fields, 2FA codes, whatever is on screen. Non-negotiables:
the user starts and stops it explicitly (never a model tool), it is visible the entire time it
runs, typed values are masked by default rather than on a heuristic, and nothing leaves the
machine unless the user exports it.

**The smaller half falls out free.** "Record me doing this so I can send it to a colleague" — no
agent, no repeat, just the write-up — is the whole of what Scribe and Tango sell, and it is the
watch half with the Skill sink switched off. Worth shipping first on its own: it is the cheap
validation that our captions are good enough to hand to a stranger, and that question decides
whether the repeat half is worth building at all.

**Open questions.** Does coalescing produce steps a person recognizes, or a mush that needs the
model anyway? Is a Skill draft enough for people who asked to "record a process", or do they
expect literal replay and read resilience as unreliability? And does a watched session need its
own retention rule, given it holds the user's actions rather than the agent's?

---

## Soon

### 4. Schedule follow-ups — ✅ shipped v0.4.3

**Pause / resume** — the record, the task and the thread survive; only the alarm goes. Resuming
recomputes `nextFireAt` from _now_: the stored one sat still the whole time it was held, so arming
it verbatim would fire the instant the switch flipped. Resuming a one-shot whose moment passed
retires it. Rendered as a switch, not a ⏸/▶ glyph — the row already spends its one ▶ on "Run now",
and two triangles side by side is a coin toss.

**"Run now" doesn't consume a one-shot** — logged as a bug; it is **correct behaviour that never
said so.** Running it by hand is a rehearsal, not the performance: consuming the one-shot would
make testing it destroy it. Fixed in copy, not logic.

**Queued fires now say so.** A fire that lands while another run holds the slot was falling back to
"Next 09:00", which read as though the click had done nothing. (An earlier draft of this file said
"you click Run now and nothing visibly happens" — wrong: the row already flipped to "Running now"
once the run _started_. The queued case was the only gap.)

**MCP exposure** of `schedule_task` / `cancel_schedule` — still deferred, same reason: an MCP
client scheduling browser work that fires long after the client is gone is a different trust story,
and it needs the domain policy under it first.

### 5. Deleting a scheduled conversation — ✅ fixed v0.4.3

`deleteConversation` cancelled queued runs but **never looked at schedules**. The rule stayed armed
over a `conversationId` pointing at a dead thread, and the next fire's
`openScheduledConversation` → `ensureConversation` **re-created the row with the same id**. So the
chat you deleted came back, empty, at 9am — and the delete that _looked_ like it stopped the
recurring task hadn't.

**Resolved by deciding the two objects are not as separable as they first appear.** A schedule's
thread is not incidental to it: it IS the memory each fire reads back, which is the whole reason
there is one conversation per schedule. Leaving the rule armed over a deleted transcript means an
amnesiac agent doing unattended work at 3am — worse than either clean outcome. So deleting the
thread cancels the schedule, and the panel's confirm names the schedule in its own words first.
"Stop it for a while" is what **pause** is for; that is why the two shipped together.

**Backstop, now the only way in:** eviction. `openScheduledConversation` reports whether the thread
was still there, and a fire that finds it gone tells the run its earlier history is unavailable —
silence is how a recurring task quietly forgets everything it knew. Narrow but real: `appendTo`
re-heads the index on every message so an actively-firing schedule stays near the top, but a
monthly one-shot three weeks out can still fall off the 50-conversation cap.

### 6. File upload

"Attach the receipt to the expense form" is impossible today — 27 tools and none of them touches a
file input.

**Model capability tables are a non-issue here, and that's the key insight.** The model never
receives the file. It names _which attachment goes in which field_; the bytes go straight from the
panel into the page. The `imagesSupported` flag only governs images sent _to the model_ — a
different path entirely.

The real constraint is that **an extension has no filesystem**, so `DOM.setFileInputFiles` (which
takes local disk paths) is out. The route that works: the user attaches the file in the panel, and
a tool sets it into the input page-side by building a `File` from the bytes and assigning it
through a `DataTransfer` — plain page JS, over the `Runtime.evaluate` path that already exists.

**Prerequisite:** panel attachments are images-only today (`conversation/ui/image.ts`). Widening
them to arbitrary files is most of the work.

---

### 7. Walkthrough follow-ups

`walkthrough/` shipped in v0.5.2: the agent performs a process and hands back a self-contained HTML
guide. These are the pieces deliberately left out of that first cut, roughly in the order they earn
their keep. Watch-and-repeat (#3) is the destination all of this is walking toward.

**Skill emission** — the bridge to #3, and the shortest path to it. A walkthrough already holds
everything `skills/distill.ts` needs, so "also save this as a Skill?" on the artifact card is
mostly wiring: a `skillOfferPref` of `ask` / `always` / `never`, defaulting to `ask`, with the
first-time offer inline on the card. `always` skips the ask, never the editable review — an
AI-written recipe goes through `SkillForm` like every other one (the `ImportSkillDialog` rule).
Panelless runs never auto-emit; the offer waits on the card.

**Somewhere to find them.** The artifact card is the only home a walkthrough has, and the
transcript is bounded — the card is spine, so it outlives every step row around it, but past
`MAX_MESSAGES` turns it still falls off the front while its blobs sit in IndexedDB, reachable by
nothing. That is a slow leak with
a UI hole in front of it. Settings → Walkthroughs (the `SkillsSection` shape: list, open, export,
delete, a storage-used line) closes both.

**Deterministic arming.** Today the model arms documenting when the user asks in prose, and
`/document` is a template that teaches the phrase. If field evidence shows models skipping the
tool, the fix is a flag on the run command that arms the recorder at run start — deterministic, and
it captures from action #1 instead of wherever the model got around to it. Deliberately not built
yet: it is state the user cannot see, and a "did that take?" footgun is worse than a phrase that
works. Wait for the evidence.

**Model-polished captions, and the language they are written in.** Deterministic captions (imperative
i18n templates poured from the model's `intent` args) are what ship, and they must stay the floor:
they cost no tokens and work with no provider configured. Polish is an explicit "Refine with AI"
button whose output lands in editable fields, generated on first export and stored once — never
unattended spend on a scheduled run nobody is watching. Tied to it: an **export-language picker**.
The whole point of the artifact is handing it to a colleague, who may not read the locale the app
happens to be in.

**Video export (`.webm`).** The frames are already there; this is the encoder. It has to be an
offscreen document — `MediaRecorder` is `[Exposed=Window]`, `OffscreenCanvas` has no
`captureStream()`, and `VideoEncoder` is not exposed to a service worker, so the SW cannot do it and
delegating still needs the offscreen host. Reason `BLOBS`, canvas + `captureStream(0)` +
`requestFrame()`, vp9→vp8 behind `isTypeSupported`, and a vendored duration fix (~150 lines) because
MediaRecorder writes no duration and the file is otherwise unseekable (crbug 642012). Two things not
to forget: the canvas needs a **letterbox policy** (a window resized mid-run yields mixed frame
sizes), and the step chip is **composited at encode time, never injected into the live page** — it
is retroactive, it cannot swallow a click, and it can never contaminate the doc's own screenshots.
Say plainly in the UI that it is a paced slideshow, not a replay: encode wall-time equals output
duration, and per-action frames are what a hidden tab can actually produce.

**MCP handoff.** A data URL is useless to an MCP client. Blobs are already keyed by recording id, so
the eventual shape is a bridge verb that streams one to the daemon, which writes a real file and
hands back a path. Nothing in the current design precludes it; nothing yet asks for it either.

**Smaller, named so they are not re-derived:** markdown export with an asset folder (needs a zip
dependency — the single-file HTML exists precisely to avoid one); ≤1fps tick frames between actions,
which is the only credible route to a video that is not a slideshow; a per-schedule "document every
fire"; and pinning an artifact so it survives its conversation being evicted — deliberately not
done, since "export it if you want to keep it" is the honest contract once Settings makes them
findable.

### 8. Stream-idle watchdog

A stream that opens and then goes silent holds the run forever: `streamSse` classifies what comes
BACK, and nothing comes back. Today the loop only retries what was refused — a hung connection is
a run that simply never ends, until the user stops it by hand. The fix is a watchdog that aborts
after ~60s without bytes and lets the loop's transient path retry.

**The shape is already proven, courtesy of olhary's finish pass (their `0837c94e`):** a
provider-agnostic wrapper applied at stream construction, never inside one transport; the caller's
signal bridged via `AbortSignal.any([callerSignal, watchdogController.signal])` — which also covers
the race where the caller's signal is ALREADY aborted and fires no event for a listener; idle
identified by the controller's abort reason (`signal.reason === IDLE_SENTINEL` in the catch), never
a mutable boolean; timer re-armed on every chunk, and the abort classified transient so the loop
retries instead of going red.

**One adaptation for this stack:** their `timer.unref()` is a Node-ism — a browser timer is just a
number and cannot be unref'd. The concern it serves (an abandoned stream holding the loop) is
self-bounded here: the watchdog's own timer is the only one, its firing ends the wait, and an MV3
worker's lifetime is Port-held while a panel watches anyway.

---

## Later

**Firefox** — the only survivor of the old roadmap, and still blocked: `chrome.debugger` has no
Firefox or Safari equivalent, and it's the whole driver. Not a port, a rewrite of the trusted-input
layer. Revisit only if a real user asks.

**Per-tool policy** — see domain policy. Needs evidence first.

**Staleness detection for virtualized lists** — the batch guard notices the page moving under a
turn's refs by counting refs the snapshot walker had to mint (`newRefs`). React-window and its
relatives defeat it by design: they recycle the same DOM nodes with new content, so the walker hands
back the ref it already had and the count stays zero. Catching that needs a content hash per ref'd
element — a real diff, on every guarded call, and a much bigger hammer than the guard it protects.
The exposure is narrow (batching a click on a virtualized row inside one turn) and predates the
guard. Revisit if a real run gets bitten.

**`prompt_cache_key` on the responses shape** — codex-rs sends its thread id as a routing hint so a
conversation keeps landing on the machine holding its cache. We have no conversation id at the
adapter (`ChatProvider.stream` takes messages, tools, signal), so it would cost either an interface
change across all three shapes or a hash of the system prompt standing in for one. Automatic prefix
caching already works without it, the gain is affinity at the margin, and we have no way to A/B it —
so: only if the cache telemetry shows ChatGPT-shape hit rates lagging the Anthropic ones.

**OAuth 2.1 for remote MCP servers** — the client half takes static per-server headers today; the
spec-complete flow (dynamic client registration + PKCE + refresh) slots in behind the same storage
shape when someone points TabRunner at a server that demands it.

**Cross-window redirect visibility** — a stop-redirect's redirected message is guarded per panel by
the document-scoped `sending` latch, so a second window watching the thread can repaint
pre-redirect storage over its view and miss the new task bubble until the follow-up run ends
(self-healing, view-only). Covering every window needs a storage-side send marker on the thread,
not a local flag — worth it only if multi-window-on-one-thread use ever makes the gap real.

**Explicit crash seam in the panel** — when Chrome kills the worker mid-run (an extension update
is the realistic one), the dead run heals for the MODEL by design: the crash window
(`RECENT_WINDOW`) keeps every step row, and the standing prompt instruction sends the next run to
`read_history` when a run looks interrupted. The USER half is implicit: the thread simply ends at
its last persisted step with no marker, no receipt, no run band. The seam needs what does not exist
today — a persisted run-START stamp on the conversation (nothing anywhere says "started but never
ended"; `lastRun` is stamped only when a run finishes), a panel check on boot, and its own quiet
line. Build it only if field evidence shows users waiting on dead runs — until then the composer
works, the next send recovers the work, and the thread's bare ending is honest if quiet.

---

## Deliberately not doing

|                                             | Why                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry                                   | The product's promise. Feedback is the user-initiated pre-filled issue (`lib/report.ts`) — nothing collected, nothing sent, the user presses Submit on GitHub or it never exists.                                                                                                                                |
| Cron strings                                | Unreadable in a settings list and needs a parser. The structured `Recurrence` union covers every case anyone named. Cron can later become a _parser_ that emits it — never the storage model.                                                                                                                    |
| Sampling params                             | No temperature/topP on any provider. The only knob is `reasoningEffort`.                                                                                                                                                                                                                                         |
| A second scheduler for "loops"              | A recurring schedule **is** a loop, and self-pacing falls out of giving the agent `schedule_task`. Two clocks on a one-slot run queue is a bug generator, not a feature.                                                                                                                                         |
| Multi-run concurrency                       | One CDP target, one run slot. A schedule firing mid-chat queues FIFO behind you. Concurrency here means two agents fighting over your keyboard.                                                                                                                                                                  |
| stdio / native-messaging MCP                | An MV3 worker cannot spawn processes; stdio servers would need either a helper daemon running (a second install surface most users don't have) or a native host per platform (store-review friction). Remote Streamable HTTP covers the actual ask. Revisit only alongside a native-host story we'd ship anyway. |
| A persistent MCP connection                 | Sessions live for one run and die with it. Between runs there is nothing listening, so server push (`notifications/tools/list_changed`) goes unseen — accepted: tools are snapshotted at run start anyway, and a permanent link costs wake-ups for a feature that works without them.                            |
| sampling/roots on MCP sessions              | Undeclared capabilities, answered -32601. Declaring what we won't honor is how chatty servers hang us. Elicitation is the one server→client request with a human at this end, and it's wired.                                                                                                                    |
| Per-assistant-turn webhooks ("message end") | Turn boundaries mid-run are ambiguous while tokens stream; steps already give finer granularity than anyone consumes. The seam is a new LoopCallback after the assistant push in the loop, if a real consumer appears.                                                                                           |
