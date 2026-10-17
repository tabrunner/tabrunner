---
name: tabrunner
description: |
  TabRunner drives the user's real Chrome (their tabs, their sessions, their logged-in accounts) to get things done on the web. Use this skill whenever the user wants something done in a browser: booking, buying, filling a form, reading a page behind a login, pulling data off a site, checking email, or any task on a site they're signed into. Also use when the user mentions "browser", "my email", "that page", "log in", "open URL", or "screenshot". TabRunner is an agent, not a scraper: give it the goal, not the clicks.
---

# TabRunner

TabRunner is a browser agent with its own model. You don't drive the browser: **you give TabRunner a
task and it drives**. It plans, navigates, reads pages, clicks, types, and reports back.

That distinction shapes everything below. Ask for the outcome ("find the Q3 invoice in my email and
download it"), not the mechanics ("navigate to gmail, click search, type invoice…").

TabRunner is provider-agnostic: any MCP agent can drive it the same way. This file is the one copy
of the skill. It ships in the plugin (`plugin/skills/tabrunner/`), and the repo's
`.agents/skills/tabrunner/` (Codex, Gemini CLI, Cursor, GitHub Copilot, Windsurf) and
`.claude/skills/tabrunner/` (Claude Code) hold symlinks to it. `docs/mcp.md` is the canonical,
human-facing reference.

## Delegate, or drive?

Two ways to use TabRunner. Pick deliberately:

**Delegate with `run`. The default.** You state the goal; TabRunner's own model plans and executes
it. One MCP turn per real event instead of one per click, and it stops to ask the user before
anything consequential. Right for anything long, open-ended, or on a site you'd have to explore.

**Drive with `browser_start` and the `browser_*` tools.** You read the page, click, and type
yourself. Right when the job is small and exact ("open this URL and read me the price"), when you
need one specific element, or when each step decides the next. Costs one MCP turn per action, so it
gets expensive fast on a real task. It also takes TabRunner's own model, and its permission rule,
out of the loop.

When in doubt, `run`. It's the reason this thing exists.

## The tools

| Tool                              | Use it for                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `health`                          | First call, and after any connection error. Says whether the browser is reachable and what to fix. |
| `run(task, images?)`              | Start a task. Returns immediately: browser work takes minutes.                                     |
| `get_status(wait?, waitSeconds?)` | Follow the run. **Blocks until something happens**: this is your wait, not a poll.                 |
| `answer(text)`                    | Reply to a question the run stopped on.                                                            |
| `steer(text)`                     | Correct or constrain a task already running, without restarting it.                                |
| `stop()`                          | End the run. Not an error.                                                                         |
| `screenshot()`                    | See the browser yourself. Works whether or not a task is running.                                  |
| `new_conversation()`              | Start a fresh thread when the next task is unrelated to the last.                                  |

Driving yourself:

| Tool                                              | Use it for                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `browser_start(goal, url?, background?)`          | Take the wheel in a new background tab. Returns the first snapshot; the goal names the history. |
| `browser_snapshot()`                              | Read the page: an accessibility tree with a `ref` on every interactive element.                 |
| `browser_network_requests(filter?, limit?)`       | What the tab asked the network: method, URL, status, failures. No bodies.                       |
| `browser_console_messages(errors?, limit?)`       | The tab's console output and uncaught exceptions.                                               |
| `browser_navigate(url)`                           | Go somewhere.                                                                                   |
| `browser_click(ref)`                              | Click by ref, as a real trusted event.                                                          |
| `browser_type(text)`                              | Type into whatever is focused. Click the field first.                                           |
| `browser_fill(ref, text)`                         | Set a field's value by ref. Lands where typed keystrokes don't; `""` clears.                    |
| `browser_evaluate(js)`                            | Run JS in the page: attributes, shadow DOM, the page's own fetch. Bounded, credential-stripped. |
| `browser_press_key(key)`                          | `Enter`, `Escape`, `Tab`, an arrow.                                                             |
| `browser_scroll(direction, amount?)`              | Below the fold isn't in a snapshot until you scroll to it.                                      |
| `browser_tabs(query?)` / `browser_switch_tab(id)` | Find another tab (filter it with `query`) and re-target every later action at it.               |
| `browser_end()`                                   | Hand the browser back. Always call it when you're done.                                         |

**Refs belong to the snapshot that made them.** Every action returns the page it produced. Act on
that, never on a ref you read two actions ago. Pass `snapshot: false` to get only the action's
result (far fewer tokens), then call `browser_snapshot` before your next ref.

**Your own tab by default.** `browser_start` opens a background tab and leaves the user's page alone;
pass `background: false` only when the task is about the page they are on.

**Driving means the guardrail is yours.** TabRunner stops to ask before paying, sending on the
user's behalf, deleting, or submitting. But that rule lives in _its_ model, which you have just
taken out of the loop. When driving, put those to the user yourself before you click. If you'd
rather not carry that, use `run`.

## The loop

```
run("…")
while state is running:
    get_status()          ← blocks until real progress; never poll in a tight loop
if state is question:     relay it to the user, then answer(their reply)
if state is done:         report the answer
if state is error:        read the error: it says what to do
```

`get_status` returns as soon as the run does something. One call ≈ one real event, so following a
ten-minute task is cheap. Never sleep-and-poll, and never assume silence means finished.

## Rules that matter

**Questions belong to the user.** TabRunner stops and asks before consequential actions: paying,
sending a message on the user's behalf, deleting, submitting an application. When `get_status`
returns `state: question`, that question is for the **user**. Relay it, wait for a real answer, then
call `answer`. Never approve a purchase, a send, or a deletion on your own judgement. That is the
one thing this skill must not do.

**Start the daemon yourself; don't send the user to do setup.** If `health` says nothing is
connected, read what it tells you and act on it. Only involve the user for things only they can do:
installing the extension, opening the panel, choosing a provider.

**Say which site.** The run starts on the tab the user is looking at. If the task belongs on a
particular site, put the URL in the task text, and TabRunner will navigate there.

**One run at a time.** TabRunner drives one browser, so the panel and this bridge share a single run
slot. If a run is already going, `run` tells you where it is. `stop()` ends your own; a run the user
started in TabRunner's panel is theirs to stop. Ask them, or wait.

**Steer instead of restarting.** If the goal is unchanged and you just need to correct course, use
`steer`. It lands between tool calls. Reserve `stop` + `run` for a genuinely different task.

**The thread has a memory.** Runs continue each other: TabRunner remembers the pages it visited and
what it found. Follow-ups can say "that invoice". Call `new_conversation` only when the subject
truly changes.

## Reporting back

When a run finishes, `get_status` gives you the answer in TabRunner's own words. Relay the substance
(what it found, what it did), not a play-by-play of the steps. If you need to verify a result with
your own eyes, call `screenshot`.

If a run ends in an error, the error text already says what happened and what to try. Pass that on
rather than guessing at causes.

## Setup, if it isn't working

`health` reports the exact problem and its fix. The usual ones:

- **Not connected**: the extension isn't installed, or its service worker is asleep. The user
  installs TabRunner in Chrome and opens the side panel once; it reconnects within ~30 seconds.
- **No provider, or one that needs a sign-in**: `health` names it and which of the two it wants;
  the user fixes it in TabRunner's settings. TabRunner runs on the user's own model, not yours. But
  direct control (`browser_start` and the `browser_*` verbs) needs no provider at all.
- **A different extension id**: usually an unpacked dev build. `health` names the id to accept.

Full reference: `docs/mcp.md` in the TabRunner repo.
