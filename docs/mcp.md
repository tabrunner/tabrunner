# MCP bridge

TabRunner's side panel is one way to give it a task. The MCP bridge is another: it lets an external
AI client — Claude Code, Claude Desktop, ChatGPT desktop, anything speaking the
[Model Context Protocol](https://modelcontextprotocol.io) — drive **the same agent, in the same
browser, with the same logins**.

The main way in is one instruction: _do this in the browser_. TabRunner plans, clicks, reads, and
reports back — with its own model, its own memory, and its own permission rules. That's `run`, and
it's the right default: you pay one MCP turn per real event instead of one per click.

When the job is small and exact, the client can also take the wheel and click through the page
itself — see [Driving it yourself](#driving-it-yourself). Same browser, same logins, same stored
transcript; what it gives up is TabRunner's model, and with it the rule about asking first.

## How it fits together

```
Claude Code / Claude Desktop / any MCP client
        │  MCP over stdio
        ▼
daemon/  (bun; @modelcontextprotocol/sdk)
        │  WebSocket  ws://127.0.0.1:17836/ws
        ▼
TabRunner extension  (background service worker)
        │
        ▼
the agent loop → your real Chrome tabs
```

The direction of that WebSocket is forced, not chosen: **an MV3 service worker cannot listen on a
socket**, so the extension can never be an MCP server itself. It dials out to a local daemon, and
the daemon is what your AI client talks to.

## Setup

**1. Install the extension** and add a provider if you haven't — a subscription sign-in or an API
key; the bridge uses whatever provider and model the panel is set to. `health` tells you whether
that provider is ready before you send a task.

**2. Enable the bridge** in Settings → MCP. It's off by default — an extension that never uses MCP
never dials the port at all.

**3. Fetch the daemon.** It's one file, and [bun](https://bun.sh) runs it as-is:

```bash
curl -fsSL https://github.com/tabrunner/tabrunner/releases/latest/download/tabrunner-latest-mcp.js -o ~/.tabrunner-mcp.js
```

**4. Register it** with your client:

```bash
claude mcp add tabrunner -- bun ~/.tabrunner-mcp.js
```

Developing on the repo instead? `.mcp.json` already points Claude Code at `daemon/src/index.ts` —
no download needed.

**5. Check the link** by calling `health`. It reports whether the extension is connected, and tells
you exactly what to do if it isn't.

The daemon starts when your client starts it; there's nothing to leave running. Re-run the curl to
update it. To run it by hand (to watch its log, say): `bun ~/.tabrunner-mcp.js` — inside this repo,
`bun run bridge`.

### Configuration

| Variable                                 | Default                            | What it does                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TABRUNNER_BRIDGE_PORT`                  | `17836`                            | The localhost port. Change it in both places — Settings → MCP in the extension must match.                                                                                                               |
| `TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID` | `ilnohobdcigbmlikjbkdpbkhciephdle` | Which extension `health` trusts. One id covers every channel: the manifest `key` pins the website's unpacked zip and dev builds to the store listing's own id. Set this to trust your own build instead. |

## The tools

| Tool                                    | What it does                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                | Is TabRunner reachable? Reports the connection, the extension id and version, and the fix when something's off. Call it first.                                                                                                                                                                                                                            |
| `run(task, url?, background?, images?)` | Give TabRunner a task in plain language. Returns immediately with a run id — browser work takes minutes. Opens its own tab at `url` or the default start page; `background: false` drives the tab the user is on. Optional images ride along as base64. A task submitted while another runs **queues** and answers with its position instead of an error. |
| `get_status(wait?, waitSeconds?)`       | Where the run stands. **Blocks until something changes** by default, so following a ten-minute task costs one call per real event, not one per poll.                                                                                                                                                                                                      |
| `answer(text)`                          | Reply to a question the run stopped on.                                                                                                                                                                                                                                                                                                                   |
| `steer(text)`                           | Drop a note into a running task — a correction or an extra constraint. It lands between tool calls; the run doesn't restart.                                                                                                                                                                                                                              |
| `stop()`                                | End the run — and cancel any of this client's queued runs. Stopping is normal control flow, not an error.                                                                                                                                                                                                                                                 |
| `screenshot()`                          | A picture of what the browser is showing right now, as an image the model can actually look at. Works run or no run.                                                                                                                                                                                                                                      |
| `new_conversation()`                    | Forget the thread and start clean. Refused while this thread has a run active or queued — stop it first.                                                                                                                                                                                                                                                  |
| `compact()`                             | Summarize the thread's history so far — runs then replay the summary instead of the whole transcript. Nothing is deleted; the raw messages stay in the user's panel. For long threads, or after a context-length error. Refused while a run is in flight.                                                                                                 |

### Driving it yourself

Delegating is the better path for anything long or open-ended — TabRunner's own model plans it, and
you pay one MCP turn instead of one per click. But sometimes you want the clicks. `browser_start`
opens a direct-control session, and every `browser_*` tool drives the real tab:

| Tool                                             | What it does                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `browser_start(goal)`                            | Take the wheel, and get the first snapshot. The goal names the conversation the user sees.       |
| `browser_snapshot()`                             | The page as an accessibility tree, with a `ref` on every interactive element.                    |
| `browser_network_requests(url_filter?, limit?)`  | What the tab asked the network — method, URL, status, failures. No bodies.                       |
| `browser_console_messages(only_errors?, limit?)` | The tab's console output and uncaught exceptions.                                                |
| `browser_navigate(url)`                          | Go somewhere.                                                                                    |
| `browser_click(ref)`                             | Click by ref — a real trusted event, not a synthetic dispatch.                                   |
| `browser_type(text)`                             | Type into whatever is focused (click the field first).                                           |
| `browser_fill(ref, text)`                        | Set a field's value by ref — lands where typed keystrokes don't; `""` clears.                    |
| `browser_evaluate(expression)`                   | Run JS in the page — attributes, shadow DOM, the page's own fetch. Bounded, credential-stripped. |
| `browser_press_key(key)`                         | `Enter`, `Escape`, `Tab`, an arrow.                                                              |
| `browser_scroll(direction, amount?)`             | Content below the fold isn't in a snapshot until you scroll to it.                               |
| `browser_tabs()` / `browser_switch_tab(tab_id)`  | Find another tab, re-target every later action at it.                                            |
| `browser_end()`                                  | Hand the browser back.                                                                           |

Every verb goes through the **same `executeTool` the agent loop uses** — one browser
implementation, no second catalog to drift. On the wire they all arrive as a single `browserAct`
method; they are discrete only at the MCP surface, because that is the shape models know.

**Refs belong to the snapshot that produced them.** Anything that changes the page invalidates
them, so every mutating action returns the fresh snapshot alongside its result — act on that, never
on a ref you read two actions ago.

**Direct control has no ask_user.** TabRunner's policy of stopping before consequential actions
lives in its system prompt, and driving directly takes that prompt out of the loop. Paying, sending
on the user's behalf, deleting, submitting — those become **yours** to put to the user first.
TabRunner doesn't hide that this is happening: the badge and the tab dot stay up for the whole
session, and every action is recorded in a conversation labelled with your client's name.

**One driver at a time.** A session holds the same run slot a task does, so direct control and an
agent run can never fight over a tab. A session left open expires after a few idle minutes rather
than locking the user out of their own panel.

### The shape of a session

```
run("find the Q3 invoice in my email and download it")
  → get_status()        blocks… returns: plan drawn, 2 steps done
  → get_status()        blocks… returns: state: question
                        "Download invoice-q3.pdf to your Downloads folder?"
  → (relay to the user, get their decision)
  → answer("yes")
  → get_status()        blocks… returns: state: done + the answer
```

`get_status` is the wait primitive. Call it in a loop until the state is `done`, `error`, or
`question` — each call returns as soon as something real happens.

### Questions are the user's to answer

TabRunner stops and asks before consequential actions — paying, sending on someone's behalf,
deleting, submitting. When `get_status` comes back with `state: question`, that question is for the
**user**, not for the model driving the bridge. Relay it, get a real answer, then call `answer`.

Some questions come with options listed under them; the run is waiting on those exact words, so
offer them to the user as they are. A question with no options is an open one — a file name, an
address — and the user's own words are the answer.

## The conversation model

The bridge keeps **one conversation of its own**, separate from whatever is open in the side panel.
Each run continues the previous ones, so TabRunner remembers the pages it visited and what it found
there — ask a follow-up and it knows what "that invoice" means. `new_conversation` starts over.

The thread shows up in the panel's history like any other, so you can read exactly what the agent
did on your behalf.

**One run at a time — the rest queue.** The panel and the bridge share a single run slot, because
they share a single browser. A task submitted while one is in flight waits in a serial FIFO queue:
`run` answers with its position, `get_status` lists the waiting line, and each queued task starts
in order as the slot frees. Only direct-control sessions refuse a second starter — they can't queue.

## When things go wrong

Every failure comes back as text that says what happened, why, and what to do next.

| Situation                          | What you get                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension not connected            | How to enable the bridge (Settings → MCP), install the extension, and wake the worker. It reconnects on its own within ~30s.                                   |
| A different extension connected    | The id that connected, and the env var to accept it (a dev build has its own id).                                                                              |
| No provider configured             | `health` says so up front. Add one in TabRunner's settings and pick it in the panel header.                                                                    |
| Provider needs a sign-in or key    | `health` names it and which of the two it wants. Direct `browser_*` control keeps working without a provider.                                                  |
| No tab to drive                    | Open a tab in the window you want TabRunner to work in.                                                                                                        |
| A run is already going             | Your task queues behind it (position reported, `get_status` shows the line) — a direct session is the only case that still refuses.                            |
| The link drops mid-run             | **The run keeps going.** The extension reconnects and re-syncs; `get_status` picks up where it left off. A long task survives a daemon restart.                |
| Chrome suspends the worker mid-run | Reported as an interrupted run, not left polling a ghost. A 30s keepalive alarm holds the worker for as long as the bridge is enabled, so this should be rare. |
| Another daemon owns the port       | Which port, and how to give this one its own. Every MCP client spawns its own daemon, so this is normal with two clients open.                                 |

## Security

The WebSocket binds to `127.0.0.1` — nothing off your machine can reach it. Within your machine,
**anything that can open that port can drive your browser with your logged-in sessions**. That is
the same trust model as any local automation daemon, and it is the reason the bridge is localhost-only
and the port is not exposed.

The daemon is a pipe: it relays tasks and run events. No page content, credentials, or API keys are
stored in it, and it never talks to anything but the extension and your MCP client.

## Connecting out to remote MCP servers

Everything above lets other AI clients drive TabRunner. The reverse direction also exists:
**TabRunner itself can be an MCP client**, connecting to remote servers and adding their tools to
its own toolkit.

Add a server under Settings → MCP → "Connect to MCP servers": a name, an `https://` URL (plain
`http://` works for localhost only), and optional auth headers — a bearer token or API key sent
verbatim with every request. "Test connection" runs the same handshake a run will, so what it
reports is what the run would see.

What a server buys you:

- **Its tools join every run** — namespaced `mcp__<server>__<tool>`, listed for the model alongside
  the built-ins, executed over the wire when the model calls them.
- **Behind plan approval like everything else.** A remote tool never fires before you've approved
  the run's plan — there is no read-only bypass, because a server's own claim about its tools is
  not ours to trust.
- **Elicitation reaches you.** A server that asks questions mid-task (`elicitation/create`) gets a
  card in the panel; answer it or decline. On runs nobody watches (scheduled, bridge) questions are
  declined automatically — declining is the safe direction.
- **Failures stay small.** A dead server costs one connect timeout per run start, contributes zero
  tools, and shows one quiet line in the transcript. It never blocks or breaks the run.

Sessions live only while a run lives. Nothing connects between runs, so a server's push
notifications go unseen — the trade for not holding a socket open in a browser worker.

On security: a remote MCP server receives whatever the agent sends it, and returns whatever it
returns — treat its tools as third-party code with network access. Auth header values stay in this
browser's storage and are never logged. The same lifecycle events can be mirrored outward by
webhooks: Settings → Behavior → Webhooks POSTs run started/finished/errored/question events to a
URL you control (fire-and-forget; one attempt, no retries).

## Developing on it

```bash
bun run bridge        # run the daemon by hand, with its log on stderr
bun run bridge:check  # end-to-end check: spawns the daemon, plays the extension, drives MCP
bun run bridge:bundle # build the single-file daemon releases ship → dist/tabrunner-<version>-mcp.js
```

`bridge:check` is the fastest way to know the wiring is intact — it exercises the hello/sync
handshake, request correlation, the long-poll, and the ask_user round trip without needing Chrome.

The wire protocol is declared twice on purpose: `src/modules/bridge/protocol.ts` (the extension's
copy, and the source of truth) and `daemon/src/protocol.ts`. The daemon is a standalone bun package
and must not import from the extension bundle — change them together.
