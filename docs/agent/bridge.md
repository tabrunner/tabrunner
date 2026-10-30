# MCP bridge internals

The bridge lets an external MCP client use TabRunner's agent or drive its browser tools
directly. Human-facing setup and tool examples: [../mcp.md](../mcp.md).

## One local broker, separate clients

Each MCP client launches `packages/mcp/src/index.ts` over stdio. That process is a small proxy:
it discovers or starts one shared broker for `TABRUNNER_BRIDGE_PORT`, then connects to the
broker over local Streamable HTTP. The extension is still the WebSocket client. An MV3
worker cannot listen on a socket, so it dials `ws://127.0.0.1:<port>/ws` on the broker.

```text
MCP client A → stdio proxy A ─┐
                            ├→ local HTTP broker ← WebSocket ← extension
MCP client B → stdio proxy B ─┘                                 │
                                                              ├→ client A's task/tabs
                                                              └→ client B's task/tabs
```

- The fixed WebSocket bind elects the broker. Losing starters use the winner; they never
  stop an existing listener. An unknown port owner produces an error with a port-change fix.
- The broker publishes its random HTTP address, bearer token, version, protocol version
  and pid under `~/.tabrunner/mcp/<port>.json`. The folder is private (0700), the file is
  private (0600), and readers reject unsafe ownership, permissions or non-local URLs.
- Proxy and broker package versions and protocol versions must match. A mismatch leaves
  the running broker alone and asks the user to update all clients and reconnect.
- Every initialized stdio connection gets a fresh opaque client id. A display name such as
  "Claude Code" labels history; it never identifies the owner. Two clients with the same
  name still have separate state. A fresh client launch is not a continuation of an old one.
- HTTP requests need the local bearer token and the expected Host/Origin. The WebSocket
  checks the configured extension Origin and hello id, plus bridge protocol v2. The default
  extension id is `ilnohobdcigbmlikjbkdpbkhciephdle`; a custom build must configure its own id.
  These are local access checks, not a boundary against another process running as the user.

## Client context and admission

`bridge.ts` routes frames to one `BridgeClient` per client id. Each controller owns its
command chain, stored conversation id, compact status, activity and direct session. A slow
command from one client does not serialize other clients.

`bridgeThread(clientId)` stores the conversation id under a per-client key. The same client
resumes that thread after worker suspension, reload or update. Direct and delegated tasks
append to the same thread; `newConversation` explicitly resets it. A new MCP session gets a
new id and therefore a new thread. None of these writes changes the panel's active thread.
The conversation still appears in history, labelled with the client name.

`active-runs.ts` admits at most four tasks across all owners. Each run has an id,
conversation id, owner category and owner id. At most one task is live per owner and per
conversation. All panel work shares ownerId `panel`, so panel tasks remain serial. MCP
clients and schedules have separate owner ids and can overlap on separate tabs.

Delegated work uses `submitRun` and the same `startAgentRun` as the panel. The supplied run
id stays the queue, registry, board and protocol id. Waiting tasks preserve order within
their client/conversation; a blocked client does not block unrelated work. Each client's
`get_status` queue contains only its own entries and local positions. Direct sessions
cannot queue: the client must end its own direct session before delegating, and it cannot
start direct control while its delegated work is active or queued.

Tab claims are separate from admission. A driver uses `ownerId: run.id`, claims a tab before
page work or indicators, and refuses a tab claimed by another run. CDP calls name a target
explicitly; there is no global "attached tab". This isolates browser commands, not accounts:
separate tabs in the same profile still share cookies, logins and server-side state.

## Controls, events and cleanup

Every request, including `sync`, carries `clientId`. Task controls also carry the expected
`runId`. The controller verifies both before stop, steer, answer, reset, compact, screenshot
or a direct action. A stale control cannot affect later work. Stop targets one exact active
or queued run id; closing a client cancels all of that client's queued work.

Each delegated run has its own `TranscriptWriter`. `status.ts` folds its events into one
client's `BridgeStatus`, forwarding only structural changes. Tokens, reasoning and usage
never cross this compact stream. Events carry `clientId`, `runId` and `conversationId`;
responses carry `clientId` and `requestId`. A queued launch sends `started` before its first
run event, so the daemon replaces the previous run's status rather than mixing their steps.

The daemon's status is a mirror. Each hello triggers per-client `sync`. A failed or timed-out
sync stays pending and retries on the next heartbeat or `get_status`, one read at a time.
Healthy mirrors do not poll. Connection and status revisions fence delayed snapshots from
replacing newer events. A reconnect that lost a live run reports it as interrupted, not
running forever. The stored conversation survives even though its earlier run may not.

Stop only aborts. It does not release admission or tab claims. The finalizer drains actions
and bounded external reads, finishes artifacts and marks, releases that run's browser
resources, then calls `releaseRun`. Direct end follows the same order, including when start
fails outside the opening snapshot. A stale finalizer cannot clear a later run's activity.

`screenshot` accepts only the caller's live run and its claimed, attached driven tab. It
never falls back to another debugger target or `captureVisibleTab`. External captures,
including tab metadata, have one 5s bound and register in the run's `pendingReads` set.
Cleanup sets `readsClosed`, waits for those reads to settle, then releases browser resources.
The recorder keeps its separate capture timeout.

## Leases and reconnects

The stdio proxy renews its broker session every 20s by default. A failed ping or upstream
initialization does not close an initialized stdio connection. The next request or heartbeat
uses broker discovery again. A short HTTP failure keeps the same session while the broker
still recognizes it. The broker sends the live client ids to the extension every 20s; each
extension owner has a 60s lease. A WebSocket disconnect starts a fresh 60s reconnect grace.
Missing owners expire independently: their queued work is cancelled and their live work is
aborted and drained. Panel and schedule owners are untouched. Expiry does not retire the
broker identity: the same live client can sync and start new work after cleanup finishes,
using its stored conversation. Requests during cleanup report recovery in progress.

`closeClient` returns `{ ok: true }` only after that owner's cleanup finishes. If the
extension is disconnected, the broker retains this cleanup request and retries it after
reconnect. It never retries a run, click, type or other browser mutation. A timed-out or
lost action may already have happened; clients must inspect status or the page before
retrying. Only an explicit client close retires its id; later heartbeats or requests cannot
revive it in the same worker.

Once no clients or cleanup remain, the broker exits after a 10s idle grace by default.
An extension link outage preserves client ids while their broker sessions stay alive. An
owner's expired task is not restarted automatically; reconnect restores its thread, not its
old work. Restarting a stdio client creates a new identity. If the broker restarts or confirms
that an upstream session expired,
the proxy opens a new upstream session without closing stdio. Its earlier status and run
controls do not carry over. `health` and `get_status` disclose the new session until the client
starts a new task or resets its conversation. No browser action is replayed.

## Direct control

`direct.ts` maps the daemon's discrete `browser_*` tools to the same `executeTool` and driver
the agent loop uses. Direct actions, start and end are ordered within their client.

- `browser_start(goal)` reuses a page this client's thread drove while it lives, otherwise
  opens the default start page in a background tab. A URL opens its own page. Only
  `background: false` without a URL adopts the user's current tab. The initial target is
  claimed before indicators or its first snapshot.
- Start returns the first snapshot plus `runId` and `conversationId`. The goal is appended
  as a user turn in the same per-client conversation that delegated work uses.
- Mutating actions return a fresh snapshot by default because refs belong to the page
  snapshot that produced them. With `snapshot: false`, the caller must refresh refs itself.
- Direct control has no TabRunner model or `ask_user` policy. The external client must get
  permission before consequential actions. On-page marks and the stored transcript still
  make the work visible.
- A session expires after five idle minutes, not during an in-flight action. Closing its
  driven tab also ends that session. End aborts, drains, removes an unused starter tab and
  releases only this session's browser resources. The same MCP client can then start another
  task without reconnecting.

## Readiness and MV3 timing

`health` reads the active provider's name and saved credential state through `providerInfo`.
It does not send a test model request or prove that a saved key is valid. Direct browser
control needs no model provider. The short provider lookup timeout cannot hold health open.
A pending status sync or failed provider lookup never reports Ready. An uncertain mirror is
labelled as the last known status, with a safe retry instead of a claim the old run is live.

`BridgeSocket.start()` stays synchronous so MV3 registers its alarm listeners in the first
worker turn. One reconcile path arms a 30s alarm when enabled and clears it when disabled.
The bridge ships disabled. A refused connection waits for the alarm; only a connection
that actually opened earns the 2s fast retry. `bridgeConnected` mirrors open/close state
through storage for UI contexts. Config remains in `bridge/config.ts`, not the socket.

The protocol is declared twice on purpose: `apps/extension/src/modules/bridge/protocol.ts` is the source
of truth; `packages/mcp/src/protocol.ts` is its standalone-package copy. Change both together.
`bun run bridge:check` checks the broker and client wiring without Chrome.
