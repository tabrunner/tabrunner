# MCP bridge internals

How the bridge lets an external AI client (Claude Code, Claude Desktop) drive the same
agent loop the panel drives. Human-facing setup docs: [../mcp.md](../mcp.md). Read this
when a task touches `src/modules/bridge/` or `daemon/`.

**The extension is always the WS client** — an MV3 service worker cannot listen on a
socket, so it can never be an MCP server itself. It dials `ws://127.0.0.1:<port>/ws`;
`daemon/` accepts, and speaks MCP over stdio to the client. Two hops, one direction of
dialling, no way around it.

**A thin front over the existing loop, not a second tool catalog.** The client sends one
task; `bridge.ts` hands it to the same `startAgentRun` the panel uses. Model resolution,
conversation memory, ask_user, screenshots and done-summary semantics all come for free,
and can never drift from the panel's.

- **One run, one slot — the rest queue.** `agent/active-runs.ts` holds a single
  `ActiveRun` tagged `panel` or `bridge`; only its owner may stop or steer it. A second
  submission goes through `submitRun`'s FIFO instead of failing: the client gets
  `{ runId, conversationId, queued: position }`, and `get_status` lists the waiting line
  (`BridgeStatus.queue`, fed by the `queue` compact event) and parks until it moves. When
  a queued run claims the slot, a `started` compact event resets the daemon's mirror —
  without it the queued run's events (and its final done) would fold into the previous
  run's terminal state. Rejection stays only for direct sessions, which can't queue. MCP
  `stop` cancels the client's queued runs before stopping the active one.
- **The bridge owns its own conversation**, created lazily and reset by `newConversation` —
  and by nothing else. Its id is stored (`bridge-conversation`), not held on the Bridge
  instance, because the worker underneath is disposable: Chrome suspends it after ~30s idle
  and destroys it on every reload and version update. An in-memory id meant the next `run`
  minted a fresh thread, so the client lost the pages it had visited and the user was left
  with an orphaned transcript.
  It never touches the panel's active thread, but it shows up in history like any other.
  `compact` folds it through the same summarizer as the panel's /compact — refused while a
  bridge run is in flight, for the same mid-story reason.
- **`health` answers the whole pre-flight**, link AND model: it asks the extension for
  `providerInfo` (active provider, whether its credential works, key vs subscription) so a
  missing or signed-out provider is reported before a task is sent instead of killing the
  first model call. That lookup uses the short `QUICK_TIMEOUT_MS` and degrades to silence
  — a slow answer must never hold a pre-flight check open, and direct `browser_*` control
  needs no provider anyway.
- **Compact events only.** Tokens, reasoning and usage never cross the WS;
  `bridge/status.ts` folds the run's events into a `BridgeStatus` and forwards only
  structural changes. The daemon runs the same reduction over that compact stream
  (`daemon/src/protocol.ts` `applyCompact`) so `get_status(wait)` can long-poll — one MCP
  turn per real event, not per poll.
- **The status is mirrored, not owned, on the daemon side.** On every `hello` the daemon
  issues `sync` and takes the extension's answer as truth. A dropped link doesn't stop the
  run; a suspended worker does, and shows up as a run that vanished across the resync.
- **The protocol is declared twice on purpose** — `src/modules/bridge/protocol.ts` (source
  of truth) and `daemon/src/protocol.ts`. The daemon is a standalone bun package and must
  not import from the extension bundle. Change them together, then `bun run bridge:check`.
- **MV3 timing.** `BridgeSocket.start()` is synchronous: a listener registered after an
  `await` is silently dropped by Chrome, and the reconcile alarm is the whole point of the
  class. One `reconcile()` owns the whole decision — it arms the alarm when enabled and
  clears it when not, so a disabled bridge costs nothing. Disabled is also the default:
  Chromium logs a refused WebSocket from the network stack (no JS can silence it), so an
  enabled-but-daemonless install spends a console error every reconcile and reads as broken
  to a user who never wanted MCP. Only a WS that actually opened
  earns the 2s fast retry; a refused connect waits for the alarm.
- **Config and link state live in storage, not in the socket.** `bridge/config.ts` holds
  the `bridge` item (`enabled`, `port`) plus `bridgeConnected`, a mirror the socket writes
  on open/close/disable so UI contexts can show the link over the storage-watch channel.
  Settings → MCP edits the same item the socket reconciles on, so a port change there
  reconnects on its own — no messaging, no restart.

## Direct control

`bridge/direct.ts` is the other half: a client that would rather drive than delegate calls
`browser_start(goal, url?, background?)` and then the `browser_*` verbs.

- **Same `executeTool`, same driver.** The MCP verbs map 1:1 onto agent tool names, so
  there is one browser implementation and no second catalog. Discrete tools at the MCP
  surface (the shape models know), one `browserAct` method on the wire.
- **A session holds the run slot**, so direct driving and an agent run can never fight
  over a tab. It expires after 5 idle minutes rather than locking the user out of their
  own panel.
- **Mutating actions re-snapshot.** A ref belongs to the snapshot that produced it, so
  acting on a stale ref is a correctness bug — every mutating verb returns the fresh page
  with its result. A client can pass `snapshot: false` (the daemon puts it on the
  `browserAct` request, `DirectSession.act`'s third argument) and then owns the staleness.
- **Its own tab by default.** The first snapshot goes to the client, so `browser_start`
  follows `run`: it reuses the tab an earlier bridge session or run already drove while it
  lives, else opens a background tab (at `url`, else the start page), and takes the user's
  current tab only when the client sends `background: false` without a `url`. A starter tab
  the session switches away from or closes without ever acting on is removed automatically.
- **Hidden tabs work.** Attach turns on `Emulation.setFocusEmulationEnabled`, so a tab in
  the background, under another window or minimized still takes the mouse press, keys and
  wheel (a hidden page queues them otherwise). `screenshot` reads the tab the debugger
  holds with `Page.captureScreenshot`; `captureVisibleTab` is the idle-browser path.
- **No ask_user.** The consequential-action policy lives in the system prompt, which
  direct control bypasses; the client carries it (tool descriptions + SKILL.md), and
  PRIVACY.md says so plainly. The compensations are visibility: badge, tab dot, and a
  stored transcript.
- **The thread is the goal.** `browser_start` opens its own conversation and writes the
  goal as its first user message, so the existing "title = first user message" rule names
  it. `ConversationMeta.agent` carries the client name (from MCP `initialize`), which
  history shows as a chip — a transcript the user never started must say where it came
  from.
