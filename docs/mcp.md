# MCP bridge

```text
run("Find the latest invoice in my email")
```

TabRunner opens a task in your logged-in Chrome and returns a run id. Call `get_status()`
to follow its progress. It uses the same agent as the side panel, with its own model and
rules about asking before consequential actions.

The bridge connects MCP clients such as Claude Code, Claude Desktop and Codex to your
browser. Several clients can connect at once. Each gets its own chat, task controls and
driven tabs. Up to four tasks can run at once across MCP clients, the panel and schedules;
the panel itself still runs one task at a time.

For a small, exact job, your client can use [direct browser tools](#driving-it-yourself)
instead of delegating to TabRunner's model. Direct control records the work in the same
client chat, but the external client must ask you before paying, sending or deleting.

## How it fits together

```text
MCP client A → stdio proxy A ─┐
                            ├→ shared local broker ← WebSocket ← TabRunner extension
MCP client B → stdio proxy B ─┘                                      │
                                                                  ▼
                                                         your Chrome tabs
```

Each client starts a small local process. Those processes share one broker, the local
process that routes their requests to the extension. You do not need separate ports for
each client. The extension dials out because its background worker cannot listen on a socket.

The extension uses one known WebSocket port, `17836` by default. The broker asks the operating
system for a free HTTP port and saves that address and its access token in a private local file.
Clients read that file automatically. Agents do not guess ports or scan a range.

## Setup

**1. Install the extension** and add a provider if you want to delegate tasks (a subscription
sign-in or an API key). A new client chat starts with your default provider and keeps its engine
once it runs. `health` reports the saved provider and credential state; it does not test a model
request or validate a key. Direct browser tools need no provider.

**2. Enable the bridge** in Settings → MCP. It's off by default. An extension that never uses MCP
never dials the port at all.

**3. Install the plugin.** In Claude Code:

```bash
claude plugin install tabrunner --marketplace tabrunner/tabrunner
```

On Claude Code older than 2.1.275, add the marketplace first:

```bash
claude plugin marketplace add tabrunner/tabrunner
claude plugin install tabrunner@tabrunner
```

In Codex:

```bash
codex plugin marketplace add tabrunner/tabrunner
codex plugin add tabrunner@tabrunner
```

The plugin brings two things. The daemon, which it starts with `bunx tabrunner-mcp@<version>` at
the plugin's own version, so you need [bun](https://bun.sh), and updating the plugin brings each
release. And a skill that tells the
model when to hand a task to TabRunner and how to follow it.

**4. Check the link** by calling `health`. It reports whether the extension is connected, and tells
you exactly what to do if it isn't.

The bridge starts with the first client. Later clients share it. After the last client closes,
it finishes that client's cleanup and exits after a 10-second idle grace by default.

### Without the plugin

Any MCP client can run the daemon from npm. In Claude Code, `--scope user` makes it work in every
project. Without it, Claude Code registers it for the current folder only:

```bash
claude mcp add --scope user tabrunner -- bunx tabrunner-mcp@latest
```

To keep a copy of your own instead, fetch the single file each release attaches, and bun runs it
as-is. Re-run the curl to update it:

```bash
curl -fsSL https://github.com/tabrunner/tabrunner/releases/latest/download/tabrunner-latest-mcp.js -o ~/.tabrunner-mcp.js
claude mcp add --scope user tabrunner -- bun ~/.tabrunner-mcp.js
```

Register TabRunner once in each MCP client so its tools do not appear twice. Different clients
can use the same port and broker. To remove a registration you added by hand, use the scope
you added it with:

```bash
claude mcp remove --scope user tabrunner
```

The file stays at `~/.tabrunner-mcp.js` until you delete it. The plugin comes out with
`claude plugin uninstall tabrunner`.

Developing on the repo instead? `.mcp.json` already points Claude Code at `daemon/src/index.ts`.
No download needed. To run it by hand (to watch its log, say): `bun run bridge`.

### Configuration

| Variable                                 | Default                            | What it does                                                                                                                                              |
| ---------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TABRUNNER_BRIDGE_PORT`                  | `17836`                            | The shared local WebSocket port. Settings → MCP in the extension must match. All clients using this port must use the same MCP package version.           |
| `TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID` | `ilnohobdcigbmlikjbkdpbkhciephdle` | The extension id accepted by the WebSocket handshake. Store, website zip and normal dev builds share this id. Set your custom build's id when it differs. |
| `TABRUNNER_BRIDGE_RUNTIME_DIR`           | `~/.tabrunner/mcp`                 | The private folder for local broker discovery and its access token. Keep it owned by your user and unreadable by other users.                             |

Clients sharing a broker must use the same package and bridge protocol versions. A mismatch
asks you to update the clients and reconnect. It does not stop the existing broker or another
program that owns the port.

## The tools

| Tool                                    | What it does                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `health`                                | Is TabRunner reachable? Reports the connection, the extension id and version, and the fix when something's off. Call it first.                                                                                                                                                                                           |
| `run(task, url?, background?, images?)` | Give TabRunner a task and get a run id. It reuses a tab this chat drove while it lives, otherwise opens a background tab. A URL opens its own page; `background: false` without a URL adopts your current tab. Extra tasks queue when this client is busy or all four task slots are taken. Images are base64 data URLs. |
| `get_status(wait?, waitSeconds?)`       | Follow this client's task and queue. Blocks until something changes by default, so you do not need to poll on a timer. Other clients' steps, questions and queued tasks are not included.                                                                                                                                |
| `answer(text)`                          | Reply to a question the run stopped on.                                                                                                                                                                                                                                                                                  |
| `steer(text)`                           | Drop a note into a running task, such as a correction or an extra constraint. It lands between tool calls; the run doesn't restart.                                                                                                                                                                                      |
| `stop(runId?)`                          | Stop this client's current task, or pass one of its queued run ids to cancel that exact task. Later queued tasks are kept. Other clients, panel tasks and schedules are untouched.                                                                                                                                       |
| `screenshot()`                          | Capture this client's live task or direct session, even in a background tab. Fails if it has no claimed, attached page. It never captures another client's page or an unrelated visible tab.                                                                                                                             |
| `new_conversation()`                    | Start a fresh chat for this client. Closes its direct session, but refuses while its delegated work is active or queued. Stop those tasks first. Other clients' chats are unchanged.                                                                                                                                     |
| `compact()`                             | Summarize this client's chat for later tasks. Nothing is deleted from history. Refuses while this chat has active or queued work.                                                                                                                                                                                        |

### Driving it yourself

Delegating is the better path for anything long or open-ended because TabRunner's own model plans it, and
you pay one MCP turn instead of one per click. But sometimes you want the clicks. `browser_start`
opens a direct-control session, and every `browser_*` tool drives the real tab:

| Tool                                                  | What it does                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_start(goal, url?, background?)`              | Start direct control on this client's earlier page or a new background tab, and get its first snapshot. Adds the goal to this client's chat and returns the session's run id. |
| `browser_snapshot()`                                  | The page as an accessibility tree, with a `ref` on every interactive element.                                                                                                 |
| `browser_network_requests(url_filter?, limit?)`       | What the tab asked the network, with method, URL, status and failures. No bodies.                                                                                             |
| `browser_console_messages(only_errors?, limit?)`      | The tab's console output and uncaught exceptions.                                                                                                                             |
| `browser_navigate(url)`                               | Go somewhere.                                                                                                                                                                 |
| `browser_click(ref)`                                  | Click by ref with a real trusted event, not a synthetic dispatch.                                                                                                             |
| `browser_type(text)`                                  | Type into whatever is focused (click the field first).                                                                                                                        |
| `browser_fill(ref, text)`                             | Set a field's value by ref. Works where typed keystrokes don't; `""` clears.                                                                                                  |
| `browser_evaluate(expression)`                        | Run JS in the page for attributes, shadow DOM and the page's own fetch. Bounded, credential-stripped.                                                                         |
| `browser_press_key(key)`                              | `Enter`, `Escape`, `Tab`, an arrow.                                                                                                                                           |
| `browser_scroll(direction, amount?)`                  | Content below the fold isn't in a snapshot until you scroll to it.                                                                                                            |
| `browser_tabs(query?)` / `browser_switch_tab(tab_id)` | Find another tab (`query` keeps only titles and URLs that contain it), re-target every later action at it.                                                                    |
| `browser_end()`                                       | Hand the browser back.                                                                                                                                                        |

Every verb goes through the **same `executeTool` the agent loop uses**: one browser
implementation, no second catalog to drift. On the wire they all arrive as a single `browserAct`
method; they are discrete only at the MCP surface, because that is the shape models know.

**Refs belong to the snapshot that produced them.** Anything that changes the page invalidates
them, so every mutating action returns the fresh snapshot alongside its result. Act on that, never
on a ref you read two actions ago. A snapshot costs a few thousand tokens; pass `snapshot: false` to
`browser_navigate`, `browser_click`, `browser_type`, `browser_fill`, `browser_evaluate`,
`browser_press_key` or `browser_scroll` to get only the action's result, then call `browser_snapshot`
before your next ref.

**Where it works.** Like `run`, `browser_start` reuses this client's earlier driven page while
it lives; otherwise it opens a background tab at your start page. A URL opens its own page.
`background: false` without a URL adopts your current tab and sends that page to the client.
Tabs work off screen. A claimed tab cannot be taken by another task; end the task that owns it
before switching another client onto it. `browser_tabs` lists open tabs, so pass `query` when
you know which one you need.

**Direct control has no ask_user.** TabRunner's policy of stopping before consequential actions
lives in its system prompt, and driving directly takes that prompt out of the loop. Paying, sending
on the user's behalf, deleting and submitting become **yours** to put to the user first.
TabRunner doesn't hide that this is happening: the badge and the tab dot stay up for the whole
session, and every action is recorded in a conversation labelled with your client's name.

**One task per client.** End direct control with `browser_end()` before calling `run` from the
same client. A direct session refuses to start while that client's delegated work is active or
queued. Other clients can work at the same time, up to the four-task limit. A direct session
expires after five idle minutes, but not during an action. Ending or stopping waits for its
in-flight browser work to finish before another task can claim those tabs.

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
`question`. Each call returns as soon as something real happens.

### Questions are the user's to answer

TabRunner stops and asks before consequential actions: paying, sending on someone's behalf,
deleting and submitting. When `get_status` comes back with `state: question`, that question is for the
**user**, not for the model driving the bridge. Relay it, get a real answer, then call `answer`.

Some questions come with options listed under them; the run is waiting on those exact words, so
offer them to the user as they are. A question with no options is an open one, such as a file name or an
address, and the user's own words are the answer.

## The conversation model

Each MCP session keeps its own chat, separate from the panel and every other client. Both
`run` and `browser_start` continue that chat, so a follow-up can refer to an earlier page or
invoice. `new_conversation` starts over for that client only. Chats appear in panel history
with the client's name.

The chat id survives an extension worker restart while the MCP client session remains alive.
Closing and reopening an MCP client creates a fresh session and a new chat. Two sessions
with the same display name are still separate clients.

A client and a chat can each have only one live task. Extra delegated tasks wait in order for
that client. Unrelated clients can start while one client is waiting, provided fewer than four
tasks are active. The panel still has one task at a time; this does not add independent panel
agents.

Each task claims the tabs it drives. A second task is refused if it tries to use a claimed tab.
Separate tabs are not separate accounts: they share the profile's cookies and logins, and
changes to an account can affect work in another tab. Do not run conflicting changes to the
same account just because the tasks use different tabs.

## When things go wrong

Every failure comes back as text that says what happened, why, and what to do next.

| Situation                                       | What to do                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension not connected                         | Enable Settings → MCP and open the side panel once to wake its worker. Call `health` again after about 30 seconds.                                                                |
| Extension id or protocol mismatch               | Update the extension and MCP clients. A custom build must use its id in `TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID`. Normal store, zip and dev builds share the default id.          |
| No provider configured, or no saved sign-in/key | Add a provider in TabRunner's settings. Direct browser tools can work without one. `health` checks saved state, not whether the provider will accept the next request.            |
| This client is busy, or four tasks are active   | Delegated tasks queue. `get_status` shows this client's waiting tasks. End a direct session before submitting delegated work from that client.                                    |
| The target tab is in use                        | Use another tab, or end the task that owns it before switching onto it.                                                                                                           |
| A request times out or the link drops           | The action may already have happened. Restore the link, inspect `get_status` or `browser_snapshot`, then decide whether to retry. Browser actions are not replayed automatically. |
| A short extension link outage                   | The same client's task can keep running during a 60-second reconnect grace. Reconnect resyncs its status. Longer outages abort and drain only the missing clients' work.          |
| Chrome restarts the worker                      | A lost task is reported as interrupted. Its chat survives for the same live MCP session. Check the page before sending it again.                                                  |
| Different MCP package versions                  | Update all clients sharing the broker to the same version, close them and reconnect. The existing broker is left alone.                                                           |
| Another program owns the port                   | Close that program yourself, or choose a free `TABRUNNER_BRIDGE_PORT` and set the same port in the extension. TabRunner does not stop unknown listeners.                          |

A client that stops responding loses its lease after 60 seconds by default. Closing a client
starts cleanup without waiting for that lease: its queued tasks are cancelled and its active
task is aborted, then cleaned up. Other clients, panel work and schedules keep running.
Reopening the client starts a fresh session, not a replay of the old one.

## Security

The broker listens only on `127.0.0.1`. Its HTTP endpoint requires a bearer token from a
private runtime file, rejects unexpected Host/Origin headers and uses a separate MCP session
for each client. The extension WebSocket checks the configured extension Origin, extension id
and bridge protocol v2. The default id is the store extension's id; custom builds must
configure theirs.

These checks do not protect you from software running as your own operating-system user.
That software can read your local files. Only connect MCP clients you trust with your
logged-in browser.

Tasks, page snapshots, screenshots and run events pass through the local bridge. It keeps
per-client status in memory, not page content or provider credentials on disk. Its runtime
file stores only the local address, token and version/process details. Provider requests
still go from the extension to the provider you chose.

## Connecting out to remote MCP servers

Everything above lets other AI clients drive TabRunner. The reverse direction also exists:
**TabRunner itself can be an MCP client**, connecting to remote servers and adding their tools to
its own toolkit.

Add a server under Settings → MCP → "Connect to MCP servers": a name, an `https://` URL (plain
`http://` works for localhost only), and optional auth headers, a bearer token or API key sent
verbatim with every request. "Test connection" runs the same handshake a run will, so what it
reports is what the run would see.

What a server buys you:

- **Its tools join every run**, namespaced `mcp__<server>__<tool>`, listed for the model alongside
  the built-ins, executed over the wire when the model calls them.
- **Behind plan approval like everything else.** A remote tool never fires before you've approved
  the run's plan. There is no read-only bypass, because a server's own claim about its tools is
  not ours to trust.
- **Elicitation reaches you.** A server that asks questions mid-task (`elicitation/create`) gets a
  card in the panel; answer it or decline. On runs nobody watches (scheduled, bridge) questions are
  declined automatically. Declining is the safe direction.
- **Failures stay small.** A dead server costs one connect timeout per run start, contributes zero
  tools, and shows one quiet line in the transcript. It never blocks or breaks the run.

Sessions live only while a run lives. Nothing connects between runs, so a server's push
notifications go unseen, the trade for not holding a socket open in a browser worker.

On security: a remote MCP server receives whatever the agent sends it, and returns whatever it
returns. Treat its tools as third-party code with network access. Auth header values stay in this
browser's storage and are never logged. The same lifecycle events can be mirrored outward by
webhooks: Settings → Behavior → Webhooks POSTs run started/finished/errored/question events to a
URL you control (fire-and-forget; one attempt, no retries).

## Developing on it

```bash
bun run bridge        # start a stdio client; it discovers or starts the shared local broker
bun run bridge:check  # check broker/client wiring without Chrome
bun run bridge:bundle # build the single-file daemon releases ship → dist/tabrunner-<version>-mcp.js
```

What ships, and where from:

- `daemon/` is also the npm package `tabrunner-mcp`. Each release tag publishes it (its `prepack`
  builds the same bundle), then its MCP Registry entry, `daemon/server.json`
  (`app.tabrunner/tabrunner`).
- `plugin/` is the plugin: both manifests (`.claude-plugin/plugin.json` for Claude, `plugin.json`
  for the Agent Plugins clients), the server config, the skill, and the logo `bun run icons`
  writes. The skill exists once: `.claude/skills/tabrunner/` and `.agents/skills/tabrunner/` link
  to it. `.claude-plugin/marketplace.json` at the root makes this repo its marketplace.
- `bun run release` moves every version in step: the extension, the package, the registry entry
  and both plugin manifests.

`bridge:check` is the fastest way to know the wiring is intact. It exercises the hello/sync
handshake, request correlation, the long-poll, and the ask_user round trip without needing Chrome.

The wire protocol is declared twice on purpose: `src/modules/bridge/protocol.ts` (the extension's
copy, and the source of truth) and `daemon/src/protocol.ts`. The daemon is a standalone bun package
and must not import from the extension bundle. Change them together.
