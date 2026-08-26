# Architecture deep-dive

Load-bearing details behind the AGENTS.md module map. Read this when a task touches a
module's internals, not on every session.

## Modules

### `agent/` — the run engine

Agent loop (stream → tool calls → results → repeat), tools, system prompt, run slot +
serial queue, run start.

A panel run **works the conversation's own tab once one exists**; before that it works the
tab the user is looking at (`resolveRunTab`). Adoption exists because the state the first
task is about — the half-filled form, the search results, the scrolled thread — lives in
that tab and nowhere else, and re-visiting its url in a fresh tab would both lose it and
open a second live session the site may read as a bot; so the run adopts and drives it
as-is, with the plan gate carrying the "don't touch this" decision.

Follow-ups keep that home: a message typed elsewhere is usually steering from wherever the
user happens to be reading (the side panel stays open across tab switches), not a move order
— and silently rebasing would put the run on a page nobody chose for the task. So while the
thread's last driven tab still lives, it wins (`continuesThreadTab` + `reuseContinuationTab`,
the path a parked answer already took), and the send-time page rides along as `submitPage`
data: drift ("just typing from where I was") against pivot ("this IS about that page") is a
judgment about words, so the model makes it — switching itself with the ungated `switch_tab`
when the request really is about that page. Adoption remains the fallback whenever nothing
stands to continue: the thread's first message, a lock whose tab died (its url seeds the
own-tab fallback), a restricted page.

**One resolution, both modes.** The composer toggle (`runModePref`: `foreground`, the
default, or `background`) decides one thing — whether approving the plan closes the
panel — and nothing else. It never reaches the worker: there is no flag on the `run`
command, no branch in `resolveRunTab`, and no shape the model can see. It used to say
"This page", which named the one thing that never changed; the two modes were also two
tab resolutions, and the label was reading out an implementation detail that had drifted
from what the toggle was for. The choice is a stored preference, not panel state: a
background dispatch closes the panel itself, so holding it in memory meant re-picking
the mode after every run.

The one behavior that still tracks watching is the follow — the driver bringing a
switched-to tab forward (`activateOnSwitch`). It is asked **live, at each switch**
(`isPanelOpen`), never fixed at run start: the mode is flippable mid-run (the band's
walk-away button, or just closing the panel), so a start-time flag would have a
walked-away run still yanking the user's window. It also holds only while the user is
still sitting on the tab being left — wander off to a tab of your own and the run
re-targets in silence. Nobody watching, nothing moves: not at send time (a continuation
reuses its tab in place), not mid-switch. The sidebar is the watch surface; the chip and
the notification click are how the user looks at the tab.

The strip is the run's working set, and it appears when the work does: sending a
message groups nothing — the user may just be passing through the tab they sent from.
The first successful action a gated tool lands on a tab files that tab into a green
group named after the task (`runGroup.touch()` where the plan gate stands — passing
the gate IS the start of work), and every later action joins the same strip. Tabs the
agent only reads stay out of it unless it files them itself with `group_tab` (same
window only — Chrome groups can't span windows): an acted-on tab is never the model's
call; a read tab that belongs in the visible set — the Docs tab a "copy from Docs"
run reads — always is. A read-only run leaves no strip at all.

The group is the conversation's, not the run's: a follow-up joins the strip the thread
already has and mints a fresh one only when that one is gone. One strip per
conversation **per window** — Chrome groups can't span windows, and the only way
across would be physically moving the user's tabs between windows, which a run
never does. `liveThreadGroup` resolves it by content, not by remembered ids (tab
and group ids die with a browser restart; urls survive them): first the tab in
hand (already grouped in a strip of ours, on a url the conversation drove), then
the records by group liveness in this window — strips outlive their tabs (the
driven tab gets closed once the task ends, the group_tab'd ones stay), so a
recorded group that still exists IS the thread's even when its recorded tab is
gone — then the window itself: a strip session-restore recreated under fresh ids
is found by what it holds, which is why the settle write records the strip's whole
membership (`stripUrls`, one `tabs.query({groupId})`) and not just the driven tab.
That is the case the driven-tab list alone cannot answer: the user closes the
finished tab and the strip stands on pages `group_tab` filed, which `tabs` never
records. The two lists stay separate on purpose — `tabs` is the model's "earlier
work" line and is capped tight for it, while the membership snapshot is never
shown to the model and is a wider net; folding them together would spend that cap
on reference tabs. A run with no strip writes no snapshot, so a read-only run
leaves the thread's last known one standing. Every pass checks ownership — a group is the thread's
only while it carries our fingerprints (green, or wearing a settle mark) — so a
group the user built around a page we happened to drive is never renamed or
joined, and a restarted browser handing an old id to somebody else's group is
never a mix-up. The strip's name is written once, at labeling;
afterwards a run only changes its mark. Settle re-marks the name the group already
carries (✓/?/✗, collapsed) — it never renames, because a continuation's task is the
user's answer fragment ("the March one"), and a name the user gave the strip
themselves is theirs. A continuation joins the parked strip without renaming it,
and a tab the user refiled while the question waited is left exactly where they
put it: no run, of any kind, groups a tab that already sits in a group that
isn't the seed — never rip.

Adoption is safe because of the plan gate, not instead of it: the run reads the page and
proposes a plan before any action tool unlocks, so "don't touch this draft" is a plan
rejection, not a reason to have forked the tab. A rejected plan names no outcome: a tab
the run _opened_ is taken back; the user's own tab keeps whatever grouping it had —
grouping starts at the first action, so a first-plan rejection happens before any of
it, and a strip that already exists (a rejected mid-run replan) just collapses. The
tab itself is never closed.

The run still gets a tab of its own when there is no page to work: a blank/new-tab page,
a restricted page (chrome://, the Web Store — Chrome forbids extensions there, so there
is nothing to adopt and the model never has to be told about a page it never saw), an MCP
client (no current tab at all — its sessions start on the neutral default), or a run the
client pointed at an explicit URL. Those forks open on `defaultStartUrl` (then google),
inactive, and are never brought forward — the user's screen never moves; the badge and
widget say the work exists. Their strip appears at the first action like any other run's.

A restricted page is a fork, not a failure: the task is runnable, only the page is
impossible. The composer watches the active tab (`useRestrictedPage`) and carries a
footnote saying the task will run in a tab of its own — before a word is typed, not after
the message is already in the transcript. Nothing about the send changes (there is no
flag to drop and no mode to override; a watching panel still stays open through the
plan), and the message carries no tab stamp, because a chrome:// chip under it would name
a tab nothing ever drove. `resolveRunTab`'s `errors.restrictedPage` stays as the backstop
for a tab that turns restricted between the panel's query and the worker's, and for MCP
direct control, where nobody is looking at a composer to read a footnote.

An unanswered question is the one case the run goes back to a tab it had before: it
returns to the **very tab** the question was asked on when that tab is still alive and
still there, page state and all — re-opening its url would lose the half-filled form or
search results the question was about. The task message tells the model whose tab it's
on (`mode.adopted`, `mode.background`), so it reads-and-plans on the user's tab and stays
put in its own.

`run-queue.ts` is the FIFO on top of the single
slot: every submission goes through `submitRun` — free slot starts now, occupied waits and
`releaseRun`'s listener pumps — and mirrors every transition to the `runBoardItem` storage
record, the ambient "what is TabRunner doing" that the status widget, the panel's
RunBoard, and the MCP `get_status` queue all read. **Runs survive the panel closing** —
port disconnect never aborts; persistence therefore lives in the worker (one
`TranscriptWriter` per run, same as the bridge always did), and a keepalive alarm holds
the worker through long provider silences while no panel pings. Done/error/question fire
OS notifications when nobody is watching — no panel connected, or a panel behind another
app (`userIsWatching` checks window focus too: a side panel behind your editor is as
unseen as a closed one). A failure that lands while you are away also turns the toolbar
badge red "!" until a panel opens, because the board empties on run end and the count
badge that carried it goes with it.

The RunBoard is scoped to what the rest of the panel cannot show: a run driving another
conversation, and queue entries other than this panel's own. The open conversation's run
already has the status band (which is why `query_run` re-sends its `driving` event to a
panel that reopened mid-run — the band's tab chip has to be there for the strip to stay
quiet), the composer's Stop and Esc; our own queued submission has the composer's card.

The system prompt carries a consequential-action policy (paying, sending on the user's
behalf, deleting, submitting need explicit permission), enforced through the `ask_user`
tool: the run ends on a question the panel renders as a card, and the answer arrives as
the next message. `choices` are optional and mean something — a few concrete options get
tappable chips, an open answer (a name, free text) gets none and the composer IS the
answer field, which the card says outright. **A question in plain prose does not pause
the run** — the model streams it, the loop sees no tool call, and the user is left
answering into a run that already moved on; the prompt forbids it and the tool-less-turn
nudge steers a just-asked question back into `ask_user`. The panel gates the card's
chips/hint and the composer's placeholder on ONE shared rule (`ui/ask-gate.ts`): the
newest question with no user reply after it. Not "the last message" — the sentence a
model streams alongside its `ask_user` call lands after the card and would otherwise
hide the answer affordance on the one question that needs it. The choices travel to
every surface that relays the question, the MCP bridge included — a client that sees
only the text invents its own wording for options the run is waiting on verbatim.

**The plan is also a gate, not just a checklist.** Action tools (navigate, click, type,
press_key, scroll) are rejected by the loop until the user approves a plan (`ACTION_TOOLS`
in `agent/loop.ts` — reads and bookkeeping stay free so the model can look before it
plans). `switch_tab` is deliberately outside the gate: it changes nothing on any page and
it is how the agent reaches the page it must read first, which for a run starting
on the tab it's driving is the normal opening move. `group_tab` rides the same exemption —
it rearranges the strip, never the page. A turn's calls run with `plan`
hoisted first (`planFirst`) — models routinely batch the plan with the step it opens with,
and in wire order that step would bounce off the gate its own approval was about to open.
A bounced call gets a step row with a `detail`, so the red ✗ opens like every other row
instead of dead-ending on "Blocked".

**A turn's calls are a batch, and the loop stops it at whatever invalidates the rest.**
The model wrote them all against one page state, so the calls behind a failed action were
written for a page that never arrived. A failed action, a closing `done`, an `ask_user`,
or a page that moved sets one latch, and every call behind it drains with a synthetic
`{cancelled}` result instead of running: the wire wants a result per tool_use id, and the
text is what tells the model apart "this failed" from "this never ran". A cancelled call
reaches nothing — no step row, no walkthrough frame, no group touch — because it never
happened, and the failed call's red ✗ is the whole story. Failed _reads_ cancel nothing
(batched reads are independent by construction), and neither does a plan-gate bounce, so
a snapshot batched behind a premature click still runs.

Two guards are what make dependent chains safe enough to sanction in the prompt. Between
calls — never after a turn's last, where the model round trip is settle enough — an action
that works the page in place (`PAGE_WORK_TOOLS`) gets `driver.settle()`: a 400ms watch for
a load starting, then `waitForLoad` if one did. Nothing waited after a click before this,
so a batched second call met a page still assembling. A tab that closes under either half
ends the wait at once — a click can close its own tab, and `waitForLoad` watches
`onRemoved` for exactly that, because a tab that is gone never reaches `complete` and the
batch behind it would otherwise stall for the full 30s timeout. Then, before a turn's
second-and-later ref actions (`PAGE_STATE_TOOLS`), a census asks whether the page grew — `generateSnapshot`
mints a ref exactly for an interactive element its registry has never seen, so `newRefs > 0`
IS the change signal, and there is no second DOM walker to keep in sync with the first.
The census is deliberately the same no-arguments `driver.snapshot()` the snapshot tool
makes: mint counts only compare between identical walks, and a narrower one would "find"
elements the model's own snapshot never registered and so report every page as changed.
A navigation (`NEW_PAGE_TOOLS` — `switch_tab` included, since after a re-target the same
id means something else) and a settle that saw the page move both skip the census, having
already answered it. Scrolling arms neither guard: it cannot navigate, and the elements a
lazy-loading page streams in as you scroll are expected — counting them as the page moving
would cancel every "scroll down, then click what I already saw" batch over a ref that is
still good. The failure direction elsewhere is conservative: an autocomplete opening
mid-form-fill costs one extra round trip, never a wrong click.

The first `plan` call of a run parks the loop on `onPlanApproval`; the panel renders the
parked proposal as an approve/adjust/reject card (`plan_approval` event + command in
`shared/protocol.ts`, resolver parked on the `ActiveRun` slot), and a stop answers "no"
via the abort listener so the loop never hangs. The parked steps are kept on the slot
beside the resolver, and the ask itself rides the run board (`running.approval`): the
broadcast arms the panels that hear it, and the board arms every other one — a panel that
opened, switched threads, or lost the port after the park reconciles its card from storage
(the same board the band's "waiting for your approval" already comes from), so the
notification's question can never render without a way to say yes. Answering takes the
ask back off the board, which settles the card in panels the `plan_answered` broadcast
never reached. The card is up in **every** panel showing the thread, and any of them can answer it. The
elicitation twin works the same way — `running.elicitation` parks a server's question on the
board, and the loop waits on one thing at a time, so parking either ask takes the other down. The
answer therefore has to travel the same way: `plan_answered` (broadcast from the worker's
command handler) is what drops the card and settles the walk-away in the windows that did
not click, which otherwise sat on a settled question for the rest of the run. The panel
that clicked still disarms its own card first — that local guard is what keeps a
double-click, or a second window answering a beat late, from resolving the NEXT gate.
Mid-run replans
re-ask only when the model says the update deviates from what was approved
(`deviates_from_approved`, a required arg on the plan call) — and not even then when the
replan answers the user's own injected mid-run message: their message already approved
what it asked for, so the loop applies that one replan silently and consumes the
steering (a later self-initiated deviation asks on its own). The judgment is the plan
writer's, not a diff's: string equality re-asked on every reworded step, which taught
users to approve without reading. The flag's own description states the bar: ask again
only when the new work could cost something the user didn't sign up for (money spent,
something sent or posted in their name, data deleted or exposed, their data or money
handed to a service, account, or place the plan never named) — any new page, tab, or
route toward the same approved end is not a deviation, and dropping work never is:
doing less cannot exceed the yes already given. A flagged deviation also carries the
model's own one-line `deviation_reason`, which the card leads with — the user reads
what the change costs instead of diffing the two lists (a reason sent on a first
proposal is dropped: with nothing approved yet there is no deviation to explain). The yes is also the conversation's, not the run's. Each
acceptance is persisted on the conversation's index row (`approvedPlan`, via the
loop's `onApprovedPlanChange`), and a later run seeds it as `standingPlan`: its first
plan call re-sends the approved arc with the flag off and is applied without
re-asking — which is what makes "continue" (typed from any tab) resume instead of
re-opening a question the conversation already settled. The standing yes is one shot:
it answers only the run's first plan call, a revision request drops it (so the
revised list asks fresh rather than riding the old yes), and the gate itself is
never seeded — every run still needs its own plan call before any action, so the
model can never act on a run that never planned. Every plan call carries the run's
whole arc,
finished steps included — the card is the progress display, so a remainder-only list
would erase what the run already did; only steps the user cancelled come off. The
backstop for a model that narrows anyway is the cursor, not a diff: a replan whose
`current` moves backwards dropped finished steps, so the plan tool's result appends a
whole-arc note (`plan.narrowedNote`) — the update still lands, since the model is the
list's one writer and a merged list would put words in its mouth.

A re-ask is not the first card again, because the run is already mid-list: the
`plan_approval` payload carries the cursor (`current`) and the list the user was last
shown at a gate (`previous`). The card checks and strikes what is already finished, counts
the remainder, and tags as `new` the steps that were not in the list they last saw — the
baseline is the last GATED list, not the last approved one, so a revised plan answers "did
it change what I asked?" rather than diffing against a plan that was never approved. Drawn
without those, seven identical rows read as a restart of work the user had just watched
happen. The diff is exact-text membership, not an alignment: a reworded step reads as new
and a dropped one shows only as a shorter list — over-marking, never a hidden change.
While the gate is up the footer band drops its plan peek (the card above carries the same
steps with more on them, and the band keeps what only it has: the amber waiting line, the
clock, Stop), and the away notification lists only the steps still ahead — one line of
text has no room to mark anything done.

A bare rejection ends the run with `errors.planRejected` as the done
summary; a rejection WITH feedback is a revision request instead — the note rides back
inside the plan tool's own result (a separate user message would collide with the
tool_results turn, which Anthropic forbids), the gate re-arms, and the revised plan is
asked about again. The note's channel is the composer: a parked gate turns it into the
answer field (the placeholder says so, like ask_user does), because a queued steer could
never land — a parked run has no tool boundary ahead — so typed text sends the plan back
and the card keeps only the one-click verdicts. The gate's arming lives only in panel
memory, so the worker re-sends it on every `query_run`: port connect, and each panel
conversation switch. The switch names its conversation on the command, because with a
panel open in every window the shared slot is whatever the last one of them opened;
connect leaves it unnamed and the worker falls back to that slot, which is what a panel
opening now is about to load anyway. A parked approval fires the same away-only OS notification as ask_user
(`tabrunner-plan`), since the user has usually tabbed away by the time a replan asks
again. **Parked speaks "waiting", never "working"**: while the loop sits on an answer the
driven tab's pulsing favicon and badge settle into the still "?" (`waitAgentIndicator` —
the same language an ask_user wait shows), the run board's entry carries `awaiting`
(`markRunningAwaiting`) so the widget pill and the panel's RunBoard swap their pulse for
the same mark, and the panel's status band drops its shimmering verb for a static
"waiting" line — motion is the "the agent is clicking" signal and a parked run is blocked
on the human, not clicking. An approve or revise re-raises the working marks; a reject's
unwind clears them. Bridge runs auto-approve — the MCP client is an AI carrying its own
consequential-action policy, with no human at its end of the wire to click approve; the
plan still crosses its event stream.

### `browser/` — page control and visibility

Accessibility-tree snapshot (injected script), CDP driver (trusted input), unified driver
seam, and ONE on-page mark (`status-widget.ts`'s pill, top-right of every page it can
paint): in its **driven** voice (lifecycle in `indicator.ts`, on the tab being worked) it
reads "TabRunner is controlling this tab" — the mark that keeps a self-typing tab from
looking possessed; in its **ambient** voice (this module's lifecycle, on every window's
active tab but the driven one) it reads "TabRunner ·" + task + queue count. A run blocked
on the user (ask_user, plan approval) settles the pill into a still "?" in either voice —
waiting-on-you, not working (`waitAgentIndicator`). When a run finishes or fails, the pill
settles into a receipt instead of vanishing — ✓ "Task finished" / ✗ "Task failed", the same
marks the run's tab group wears — and the page clears it after a few seconds
(`settleAgentIndicator` / `settleStatusWidgets`; a user stop or a rejected plan just
removes the mark, the panel already says so). The driven tab also gets an amber dot over
its favicon so the strip shows where a run is working — the dot pulses via frames pushed
from the worker, because Chrome throttles hidden-tab timers and hidden is exactly when the
strip signal matters; a waiting run's favicon settles into the still "?" too. The badge is
never pulled mid-run: it used to be, so a mid-flight replan stripped the page of every sign
TabRunner was on it. Both voices share one host id, one paint function, one Hide button
(collapse in-page to a small blinking dot; a click on it brings the pill back) — the
ambient half never paints over or strips a driven badge (`drivenTabs` guards eligibility),
which is what makes the switch_tab handover safe. Every mark is
click-to-open (one `tabrunner-mark` message to the worker; it pulls the driven tab forward —
window included — and opens the panel beside it in that window, so a pill clicked from some
other window lands you next to the work), which is why every coordinate
click runs inside `withMarksClickThrough` — the agent clicks by viewport point, and a
badge that swallowed one would both lose the step and open a panel nobody asked for. Also
`restricted-url.ts` (`isRestrictedUrl`, the proactive form of the injection rejection);
the ambient pill is removed everywhere when idle or hidden via the `widgetHidden` pref.

**The tree stays primary, but it is not the whole toolbox.** Form fields carry their
current state in the snapshot (`value="…"`, redacted when sensitive; `(checked)` on
checkbox/radio) because the one value the model must verify is the one a buggy page eats.
When trusted keystrokes don't land — swallowed handlers, focus that won't stick, a field
to clear — `fill(ref, text)` (`fill.ts`) sets the value page-side through the element's
own prototype setter plus input/change, the one path every framework treats as real input
(contenteditable goes through `execCommand("insertText")`, deprecated but the only
insertion rich-text editors respect). When the tree can't answer at all — an attribute it
omits, shadow DOM, the page's own functions, an endpoint the page uses — `evaluate`
(`cdp-driver.ts`'s `evaluateRaw`) runs the model's JS via CDP `Runtime.evaluate`: exempt
from page CSP (a string eval injected into the MAIN world would die on strict
`script-src`), promises awaited, replMode with an async-IIFE retry for top-level
`return`. Its result crosses `sanitize.ts` before the model sees it: depth/string/array
caps plus a total budget, and credential-shaped values (JWTs, bearer strings, cookie
pairs, key names like `token`/`secret`) blocked outright — the run drives logged-in
sessions, so blocking beats leaking into the transcript and the provider's logs. Both sit
in `ACTION_TOOLS`: page-context JS can do anything a click can, so it waits for the same
plan approval, with the code visible in the step row's args. The read half —
`read_network_requests`, `read_console_messages` (`inspect.ts`) — stays outside the gate:
per-tab ring buffers fed by the Network/Runtime domains enabled at debugger attach, so
the failing request is already in the log when the model thinks to look. Requests carry
no bodies by design (bodies are where tokens live; evaluate can re-fetch a GET). All
page-side injection goes through `inject.ts`'s `runInPage`, the one home of the
transient-vs-restricted error mapping. The attach itself is lazy — the first tool that
needs it, not the run's start — and the session is released (`detachAll`) when the run
slot frees: done, error, stop, or parked on a question, and a direct session's `end()`
likewise. Chrome's "started debugging this browser" infobar leaves only with the
session, so a kept attach would pin the banner on a page nothing is driving — the
session even outlives the MV3 worker. The next run's first action re-attaches, and the
banner's return while the agent is actually working is honest signal.

**Three ambient signals, and only one of them is guaranteed.** The on-page pill (either
voice) is `chrome.scripting.executeScript`, which a restricted page, a PDF viewer, a
`file://` url without file access, or a hostile CSP can refuse — silently, because a run
must never fail because its marks could not be drawn. The ambient voice has two more holes:
`widgetHidden` turns it off for good, and it skips the driven tab, which under tab adoption
IS the tab the user is looking at. So the injected layer can be entirely absent, and closing
the panel would leave nothing on screen. `action-badge.ts` is the floor beneath it: a
toolbar count (or "?" when parked on the user, or a red "!" for a failure nobody was there
to see) painted by the browser itself, on every page type, whatever the pref says —
cleared at worker boot, since badges outlive the worker that set them. The run's green tab group is injection-free for the same reason. A refused paint
is therefore a degradation, never a dead end; `showAgentIndicator` treats it as one and
skips the favicon heartbeat rather than firing a doomed `executeScript` every 700ms forever.

### `providers/` — config and sign-in

OpenAI/Anthropic/Responses adapters, presets, storage, config UI (add/edit dialog, list,
the composer's engine picker, first-run onboarding). Adding a provider is a data change in
`presets.ts` — never a code change elsewhere. (A new WIRE SHAPE is the exception: adapter

- factory case + `ProviderShape` union.) Preset ORDER is the picker's order and its first
  entry is the add form's default, so the subscription rows lead: a plan the user already
  pays for beats sending them to a billing console before their first task.

Sign-in is shared too: `oauth.ts` owns PKCE, the redirect capture, and the token POST; the
per-vendor files own only client ids, authorize params, and which claim names the account;
`oauth-flows.ts` is the ONE registry (`signIn` + `refresh` per preset id) that both the
sign-in card and the credential seam read, so a provider can't be half-wired;
`ui/OAuthSignIn` is the one card for all of them, its copy parameterized on the display
name and the vendor's host. **A token in the body — not a 2xx — is what makes a sign-in
successful**: vendors answer 429 with a usable credential (a plan over its usage limit),
and discarding it would force a pointless re-login. A pasted key is verified before it's
stored (`isKeyRejected`, one model listing); only a flat rejection blocks the save, since
a 404 (no list route) or an offline endpoint proves nothing about the key.
Credential-shaped copy is credential-aware end to end — a signed-in provider never gets
told to fix an API key it doesn't have (`errors.kindAuthSignedIn`,
`chat.hint.signedOut`).

**A subscription token dies at Anthropic's CORS gate unless the request carries no
`Origin`** — a service worker is a document context, so Chrome stamps
`chrome-extension://<id>` on every fetch and the org gate 401s it. `providers/origin.ts`
strips `Origin`/`Referer` from our own calls to the preset hosts via a
declarativeNetRequest session rule; a user-typed custom endpoint keeps its Origin. This is
the sanctioned shape, not a hack: the official Claude for Chrome extension declares the
same `declarativeNetRequestWithHostAccess` permission and ships no static rule resources,
so it too does its header surgery with runtime rules. (`chrome.identity` is closed to us
for a different reason: it forces a `chromiumapp.org` redirect, and the CLI client ids we
reuse only accept `http://localhost:<port>/callback`.)

### `conversation/` — chat and persistence

Stored conversations, message types, chat UI (MessageList, ChatInput, RunStatus, RunBoard,
ConversationList). `transcript.ts` is the persistence half of the event stream,
background-safe: one `TranscriptWriter` per run turns run events into stored messages. The
worker owns it for every run (panel runs included — the panel closes itself after submit,
so a panel-side writer would die with it); the panel store only renders. Two views of one
event stream, and they must stay in lockstep. The writer also stamps the run's closing
numbers (span, tokens) onto the conversation's index row (`recordRunSummary`), because the
panel's own run state dies with the panel: a reopened panel renders the status band from
the ambient records — the board's running entry (`startedAt`, `awaiting`) while the run is
live, the stored `lastRun` once it ends — so the band and its plan peek survive the close,
until the next user message retires the record.

### `skills/` — named recipes

Skills are the roadmap's tier 3: a `## site:` section that grew a name. The record is
structured — `Skill { id, name, description, sites?, body, enabled, source? }` in one capped
array (`store.ts`, the schedule store's shape and write chain) — and SKILL.md markdown is only
the interchange form: `skill-md.ts` is the one parser every inbound path shares (URL import,
paste, the distillation reply) and the serializer export uses, a hand-rolled frontmatter subset
that splits on the first colon so prose colons survive, and reports unknown keys instead of
rejecting them — a Claude Code SKILL.md must import cleanly. Name grammar is kebab, unique,
`"new"` reserved (it's the create subcommand); every save rule lives in `saveSkill`, nowhere
else.

**Activation is progressive disclosure, resolved once at run start.** `loadSkillsForRun(url)`
joins the same `Promise.all` as `loadAgentContext` and snapshots two lists: `applicable`
(unsited skills plus those whose `sites` match the start host via `lib/host.ts` — the one
matcher, no fork) feeds a `# Skills` catalog section, one `- name: description` line each
(descriptions capped at 250 chars; past a 4k budget the listing degrades to bare names); `all`
(every enabled skill) is the `skill` tool's lookup table, so a skill the task names outright
loads from any site — scoping is discovery, not a boundary — and mid-run edits never rewrite a
live run. Bodies are never auto-injected: that would rebuild the unwieldy-AGENTS.md problem
skills exist to solve. The tool is read-only (never plan-gated), offered only when enabled
skills exist (REMEMBER_TOOL's rule), and its transcript row leads with the loaded name while
the drawer shows the instructions as text.

**`/skill` is the user door.** `/skill <name> [args]` resolves exact-then-unique-prefix against
the panel's synchronous catalog mirror (`ui/catalog.ts`) and sends a _localized_ task naming
the skill — the model mirrors the message's language, and the body still arrives through the
tool, so the transcript stays an honest record of what was sent. `/skill new` opens the draft
dialog: the full stored transcript (display caps don't apply) is rendered by the same
`renderTranscriptMessage` compaction uses, distilled by a one-shot call shaped like the other
three (fresh provider, no reasoning effort, text-only, 90s bound) — except this one **throws**,
because a user-initiated draft owes a message and a Retry, not a silent shrug. The draft lands
in the shared `SkillForm` for review; nothing persists until Save. Both forms are
`deferWhileBusy`. The dialog takes the conversation id as a prop from the sidepanel App so
skills/ui never imports conversation/ui back.

**Import is the product's one non-provider fetch, and the preview is the consent gate.**
`resolveSkillSource` (pure) accepts a raw https URL, a GitHub blob/tree URL (rewritten to
raw.githubusercontent.com), or `owner/repo[/path]` shorthand; the fetch runs in the options
page context (the `/usage` precedent — never the worker), https-only, 10s timeout, 256KB cap.
The parsed result is shown _in full, editable_, before anything is stored — an imported body is
untrusted prose that will ride the system prompt on matching runs, and a skill instructing
badly is user-approved content by construction. Nothing in a body is ever executed or fetched.
Export is copy-as-markdown, which round-trips through the same parser.

### `walkthrough/` — walkthroughs

"Do X and document it": the task performs the process and leaves behind a shareable,
step-by-step guide. The structural advantage over a Scribe-style recorder is that we know
what each action _meant_ — tool, `intent`, result, click point — so a caption reads "Click
Compose" where DOM diffing can only manage "click #btn-42". Nothing here infers.

**Why per-action screenshots, not a screen recording.** `Page.startScreencast` is driven by
the compositor, and a hidden tab stops compositing — no `IncrementCapturerCount` on that
path — so it records nothing exactly when TabRunner runs most: an adopted tab the user
switched away from, a minimized window, a 3am schedule. `Page.captureScreenshot` forces a
frame out of a hidden tab (Chrome ≥131), which makes it the only background-safe recorder
there is. Video, when it comes, is a paced slideshow built from these same frames.

**The capture seam.** `loop.ts` brackets each tool call with `recorder.beforeAction` /
`afterAction`, both awaited. `onStepStart` is synchronous and non-awaited, and a turn's tool
calls execute back-to-back with no model latency between them — so a fire-and-forget capture
would race the next action's input on the same CDP session and land mid-click. The recorder
bounds itself with a 5s timeout, so an unresponsive tab costs one gap frame, never a stalled
run; after three failures in a row it stops trying and says so, rather than adding minutes to
a run and producing a document of placeholders.

**Which frame.** Element actions (click/fill/type/press_key/evaluate) get the frame _before_
— the reader needs the screen with the target still on it. Navigations get the frame _after_,
because "Go to gmail.com" wants the inbox under it. Scrolls and agent machinery (snapshot,
find, read_*) are not steps a reader performs and get no frame at all; the next action's frame
already shows the scrolled page. A frame's verdict is filed after its action resolves, which
is what drops failed attempts — and that is what collapses "clicked, missed, retried, worked"
into the one step to perform.

**Consent and visibility.** The `document` tool is offered only while `walkthroughsEnabled`
(the `buildToolDefs` gate, same shape as memory and skills), and it is ungated bookkeeping —
capture changes nothing on a page, and the consent that matters is the user asking in their own
words. The recorder never attaches the debugger itself: frame 0 falls back to
`captureVisibleTab`, so the "debugging this browser" infobar can never precede the plan gate's
yes. REC shows in three places — the panel's run band, the driven tab's badge ("Documenting"
instead of "Driving"), and the toolbar tooltip, which needs no injection and so survives a
panelless scheduled run. Amber-gold, not red: recording is the run measuring itself, and red
already means failed here.

**Storage.** Frames are Blobs in IndexedDB (`store.ts`) — the codebase's only binary store, and
the upgrade path `conversations.ts` has named twice. Three forces pick it: base64 in
`storage.local` would blow the quota, Chrome keeps large Blobs as files rather than inline
values, and it is the one store a future offscreen encoder can reach (an offscreen document gets
`chrome.runtime` and nothing else of the extension APIs). Every frame is on disk before the next
is taken, so a killed worker leaves a recording the boot sweep marks `partial` rather than a
ghost. Recordings are GC'd with their conversation, on both the delete and LRU-eviction paths.

**Honesty.** Frames live outside `messages[]`, so a recording structurally cannot reach a
provider. Values typed into credential-shaped fields are masked in captions
(`sanitize.ts`'s regex). And everything less than the whole truth is disclosed in the document's
own intro — interrupted, truncated, started documenting late, screens that could not be
captured. A walkthrough that silently skips a step it took is the failure this module refuses.

`finalize()` runs inside `start-run.ts`'s one `finally`, **before** `detachAll()`: that is the
seam every ending funnels through, so a run that was stopped, errored, or lost its tab still
yields the document it had earned. `recorder.ts` stays out of the module barrel — it reaches
into the CDP driver, and the barrel is imported by the panel, the viewer page, and the
background entrypoint WXT evaluates at build time.

### `mcp/` — the outbound MCP client

The client half (`bridge/` is the server half): TabRunner dials OUT to remote Streamable HTTP
servers and offers their tools to its own model. Hand-rolled transport (`client.ts`) — POST
JSON-RPC, answers come back as JSON or an SSE stream — because the official SDK assumes Node APIs
the worker doesn't have. The state machine is small on purpose: initialize adopts
`Mcp-Session-Id` and the negotiated protocol version; a 404 or `-32001/-32000` mid-call means the
session expired and earns exactly ONE single-flight re-handshake + retry; everything else fails
that call as an error result. `callTool` never throws into the loop.

**Lazy sessions.** Nothing connects between runs: start-run kicks off `loadMcpForRun()` right
after provider setup so it overlaps tab resolution, awaits it before the loop, and closes every
session in the OUTER finally — outer because the early provider/target returns above never reach
the inner one. Server push between runs goes unseen (no GET listener stream); accepted, since
tools are snapshotted at run start anyway.

**One snapshot per run.** Tools resolve once into the model's tool array via `buildToolDefs`'s
last parameter — the prompt-cache invariant (`providers/anthropic.ts` marks its prefix off this
exact array) means the array must be byte-stable across turns. Ingestion (`schema.ts`) enforces
the budgets at one site: object-typed schemas only, descriptions capped at 2048 chars, a total
description budget across servers that drops whole tools deterministically in stored order.
Exposed names are `mcp__<server>__<tool>` with a hash suffix when truncation would collide;
resolution is always through the ref map — names are never parsed apart.

**Gating.** `isGatedTool` extends the plan gate by prefix: every remote tool gates regardless of
annotations, which are self-reported by an off-device server. A failed remote call does not cancel
its batch siblings — it matches none of the page-work sets, correctly.

**Duplex.** `elicitation/create` is the one declared server→client capability. start-run injects
an owner-aware handler: panel owners park it like the plan gate (event → card → command → resolve,
abort declines), bridge/schedule owners decline immediately — nobody is present, and declining is
the safe direction where the gate auto-approving plans was theirs to give. roots/list and sampling
are undeclared and answered -32601 from the dispatcher table, so chatty servers can't hang us.

### `hooks/` — lifecycle webhooks

User rules that POST run events outward — the extension-viable form of Claude Code-style hooks,
since there is no shell here to exec. Four events tap seams start-run already owns:
`run_started` (after the provider resolves, so a delivery never describes a run that isn't),
`ask_user`, `error`, and `run_finished` with its outcome. Delivery (`fire.ts`) is fire-and-forget
by contract: one attempt, 10s timeout, no retries; long strings clip at the source so payloads
stay bounded by construction; header values ride verbatim but are never logged. Failures stamp a
per-rule `lastDelivery` receipt the Settings row shows and stay quiet. Deliveries join the memory
keepalive window (`Promise.allSettled([extraction, titling, hooksPending()])`) rather than arming
a second alarm — a `run_finished` POST that outlives the run still gets its worker time.

### `tips/` — rotating tips

The rotating "Tip: …" line (Claude Code's spinner-tip pattern, reduced): a dim hint under
the running run band, or above the composer card while idle. It is the footer's
lowest-priority tenant — a queue card, an attachment, or a paste hint evicts it (the
band's slot yields to a busy composer; the composer's to anything in it). Tips are i18n
data (`tips.*` keys, object-map variant of the `run.idle` array
pattern); `registry.ts` owns ids and per-tip cooldowns in panel opens; `scheduler.ts`
picks least-recently-shown among the cooled-down (never-shown is always eligible) and
persists `tipStats`. Re-picked only at boundaries — panel open and each run end, from the
sidepanel App — never on a timer. One module-level current tip, so both slots agree;
`tipsEnabled` pref opts out.

## Data flow

**Conversation storage** (`conversation/conversations.ts`): a `conversations` index of
metadata (id, title, counts, driven tabs) plus one `conversation:<id>` key per transcript
— appending rewrites a single transcript, never the whole store. Every write names its
conversation: the panel appends by the id it is showing (`appendMessageTo`) and mints a
fresh thread outright (`appendMessageFresh`), so the worker appends (e.g. a cancelled
queued run's breadcrumb) the same way. The shared `active-conversation` slot is never a
routing input — a pill or notification click can re-point it between "New chat"
and the first keystroke, and an append that resolved it would file the fresh opener under
the thread the user just left (the "conversation switched itself" bug). The `run` command
carries the adopted conversation id for the same reason: the run files where its task
message landed, not wherever the slot happens to point when the worker handles it. So does
`compact`, whose whole job is naming a transcript, and so does the `query_run` a
conversation switch sends.

The slot is what every panel **follows**. Chrome draws one side panel per window; they are
separate documents sharing this one key, so a thread opened in any of them is the thread
all of them are on — without the watch, a notification click re-pointed the slot and only a
panel that happened to be closed at the time ever noticed (`sidePanel.open()` is a no-op on
one already up). Following makes that bug reachable from another window, which is why
`sendTask` holds the follow off between Enter and the stored message: for those few
milliseconds this panel's thread is fixed, or a slot moved during the tab query files the
user's message under the thread they just left. The follow also leaves the composer alone —
losing half a typed message because another window changed the subject is worse than a
draft outliving its thread.
Every write is read-modify-write and the panel fires them from an event stream, so
appends/replaces are **serialized** on one promise chain — concurrent
appends otherwise read the same array and the last write wins. `sendTask` **awaits** its
user message before posting `run`: the worker builds the run's history by reading the
transcript, and a fire-and-forget write loses that race every time. A fresh conversation
is created lazily by its first message, so "New chat" never leaves an empty row behind.

The index row carries what the thread runs on (`engine`: provider id, plus the model and
effort as _picked_ — absent model means auto, so a pinned thread still follows the endpoint's
newest). It is written at the first run and rewritten whenever the picker names something
else; `providers/engine.ts` resolves it, falling back to the stored default when the pinned
provider is gone (the run then re-pins, so the chip never names an engine that cannot run).
A schedule freezes its pick at setup time on the `Schedule` record instead, because its
thread is not created until the first fire — hours or days after the user set it up.

The transcript doubles as the model's memory, strictly per conversation: at run start the
background rebuilds _that_ conversation's transcript as alternating user/assistant wire
turns (`buildConversationHistory` in `agent/history.ts`) — entries capped, a char budget
scaled to the model's window and spent newest-first, the original task always kept — and
replays it ahead of the new task message, so "continue" lands on a model that has read the
same exchange. A new chat starts clean; the only context that crosses chats is AGENTS.md /
MEMORY.md. Steps and reasoning stay out of it; outcomes live in the assistant's own words,
ask_user questions included. Conversations remain scrollback you can revisit and delete.

Compaction (`agent/compact.ts`) is how that memory shrinks without the scrollback losing a
line. `/compact` — or the context-overflow error's own fix button — summarizes everything
since the last compaction into one `summary` message **appended** to the transcript: replay
then starts at the newest summary instead of the top, and every raw message stays in storage
and on screen (the fold in the chat renders as a seam with its receipt, openable to the
summary itself). The summary is a fact about what the model reads, never about what the user
keeps. A live run folds its own wire turns instead (`compactRunMessages`): proactively when
the last turn's real input tokens come within a fixed reserve of the window, reactively once
when the provider rejects the prompt as too long. The window itself is never a hardcoded
model table — `providers/context-window.ts` prefers ceilings learned from actual rejections,
then the model listing's own `context_length`, then a 200k default.

That last rung is the reason the module exposes **two** readings. `contextWindowFor` always
answers a number and is what the loop plans against: guessing 200k only risks compacting a
little early, and the reactive path corrects it for good. `knownContextWindow` returns
undefined instead of guessing, and is what anything the USER reads must call — the run band's
gauge draws a bar and a "24.3k / 200k" ratio only when the window was measured or published,
and otherwise shows the token count alone. A percentage computed against a guessed
denominator is a statistic nobody verified, and the user would act on it. The count itself is
the last turn's real input — cumulative `input` sums every turn and cannot say how full the
context is. Both ride the same `usage` event, which carries the run's **running totals**
rather than a per-turn delta: `input`/`output` are what the run has spent, `contextTokens` is
that last turn's input, and a consumer sets rather than accumulates. Absolute because a panel
that opened mid-run has seen none of the deltas — `query_run` answers with the totals and that
is enough — and `contextTokens` is spelled out rather than inferred, because inferring it from
a cumulative `input` reports a short thread as several windows full and turns the gauge red on
nothing.

Between runs the reading comes from **`ConversationMeta.contextTokens`**, stamped by the
writer when the run ends. It sits on the conversation rather than inside `RunSummary`, where
it started, because it is not a fact about a run: a run's duration and cost are over when it
ends, the context it left behind is not. `lastRun` is retired by the next user message (the
band above the composer speaks for the run that just finished); the occupancy is not, or the
gauge would blank the instant you press send and come back a minute later with the number it
already had — in exactly the panels with no live figure of their own, which is every reopened
one and every other window. A fold moves it too (`noteContextFreed`), so the receipt's
18.4k → 1.2k is not contradicted by the gauge right above it.

The gauge is a **readout, not a button**. It used to compact on click; gold measures and
emerald acts, and a measurement that spends a model call when the cursor slips is a trap in
the one band the eye lands on between runs. Nothing is dead-ended by removing the click,
because nothing is owed at the top of the scale: the run folds its own turns as it approaches
the ceiling, a turn that overflows anyway carries "Compact and retry →" on the error itself,
and `/compact` remains the deliberate fold. The tooltip names it.

Both entry points refuse to compact a conversation with a run in flight, and the check that
counts is the worker's (`getActiveRun()?.conversationId`) — the panel's own guard reads its
local status, which a panel reopened onto a background run of its own reports as idle.

A fold is **cancellable** (`cancel_compact`, and Esc from anywhere in the panel — a run and a
fold are never in flight together, so the key has nothing to arbitrate). The worker holds the
`AbortController`, keyed by conversation, because the worker owns the call: the panel that
asked can close mid-fold and a second window's Esc has to reach the same handle. A cancel
comes back as a `compact_failed` marked `nothing`, so it lands as the same quiet note every
other command result does rather than a red "Couldn't compact — the operation was aborted" —
the same rule that makes a user stop end a run with `done`. The panel does not settle its own
row on the ask: an abort that lost the race by a millisecond would leave a summary in storage
that no panel went to fetch.

The panel watches the run board, not transcripts, so a compaction with no run in flight would
write a summary nobody told the panel to look for — the card only appeared once the next
message started a run. The `compacted` event is that signal: the store refetches the
transcript on it, and drops the receipt's delta from the gauge so the number moves when the
work does.

A run that ends before writing any closing summary used to fall through that design —
no assistant words, so the work vanished from the replay and "continue" started blind.
The writer closes the hole itself: on an `error` event, and on the summary-less `done`
a user stop unwinds into, it appends a deterministic progress note
(`conversation/progress-note.ts`) built from the run's persisted step rows —
deliberately NOT a model call, since the failures that reach there (a 429, a dead tab)
are exactly the ones where asking the model to summarize would fail too. The two
endings close differently: a failure tells the next run to resume, a stop hands the
next move to the user and merely offers the history — stopping often means "do
something else", and the work should be available, not mandatory. (A run that ends on
`ask_user` writes no note; its question is its closing word. The note also consumes the
steps it reports, so a closed tab — error, then abort — leaves one note, not two.) The
note is an assistant message, so it replays like any other — but an `internal` one: it
is written in the model's language, down to the read_history instruction, so the chat
never draws it (`Transcript` filters `internal` out before grouping). What the user gets
in its place is one quiet line at the seam — "You stopped this run — your next message
can pick up from here." — appended by the writer and mirrored live by the panel store, so
the halt is on screen the moment it happens and still there on reopen. It marks a user
stop only: an abort the tab's death caused already settled as an error, and its bubble is
that run's closing word. When the model
needs more than its outline, the `read_history` tool pages the stored transcript
(user/assistant/error turns, plans, step rows with optional result extracts) by absolute
index — append-stable while the current run keeps writing — newest window by default,
char-capped with `to` marking where to continue.

**Tabs belong to messages, not to the conversation.** One run per message, and the user
moves between messages: each user message is stamped with the tab it was sent from (shown
in the transcript once the conversation spans more than one tab — every run adopts that
same tab, watched or not, so the stamp names the tab the run is about), and the
conversation keeps the tabs its runs drove — deduped by url, newest first, capped. A run
starts on the submit-time active tab; the task message names any stored tabs the user is
not on, so "that email" and "the doc" can find their way back via list_tabs/switch_tab.
The stored tab keeps its `tabId` and — only when it ended its run inside the group that
run labeled — the thread's `groupId`: the first so a continuation can return to the live
tab, the second so follow-ups file under it and the run retitles only a group of its own,
never a group the user filed the tab into (a mid-run `switch_tab` into a user's group
records no `groupId` at all).
