#!/usr/bin/env bun
/** Shared-broker integration check. Uses private temp files and no real browser. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  emptyStatus,
  type BridgeProviderInfo,
  type BridgeRequest,
  type CompactRunEvent,
  type DaemonMessage,
  type ExtensionMessage,
} from "./src/protocol";
import type { BrokerMetadata } from "./src/runtime";

const runtimeDir = await mkdtemp(join(tmpdir(), "tabrunner-bridge-check-"));
const pingFault = join(runtimeDir, "fail-next-ping");
const pingFailed = join(runtimeDir, "ping-failed");
const bootstrapFault = join(runtimeDir, "fail-next-initialize");
const bootstrapFailed = join(runtimeDir, "initialize-failed");
const pauseInitialize = join(runtimeDir, "pause-next-initialize");
const initializePaused = join(runtimeDir, "initialize-paused");
const releaseInitialize = join(runtimeDir, "release-initialize");
const preload = join(runtimeDir, "fail-upstream.ts");
await Bun.write(
  preload,
  `import { existsSync, rmSync, writeFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (init?.method === "POST" && typeof init.body === "string") {
    const method = JSON.parse(init.body).method;
    if (method === "initialize" && existsSync(${JSON.stringify(pauseInitialize)})) {
      rmSync(${JSON.stringify(pauseInitialize)});
      const response = await originalFetch(input, init);
      writeFileSync(${JSON.stringify(initializePaused)}, response.headers.get("mcp-session-id") ?? "");
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(releaseInitialize)})) return;
          clearInterval(timer);
          resolve();
        }, 10);
        init.signal?.addEventListener("abort", () => {
          clearInterval(timer);
          reject(new Error("Test-owned initialization aborted"));
        }, { once: true });
      });
      return response;
    }
    for (const [target, trigger, receipt] of ${JSON.stringify([
      ["ping", pingFault, pingFailed],
      ["initialize", bootstrapFault, bootstrapFailed],
    ])}) {
      if (method !== target || !existsSync(trigger)) continue;
      rmSync(trigger);
      writeFileSync(receipt, new Headers(init.headers).get("mcp-session-id") ?? "");
      return new Response("One test-owned upstream failure", { status: 503 });
    }
  }
  return originalFetch(input, init);
}, originalFetch);
`,
);
const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = reserved.port;
assert(port);
await reserved.stop(true);
const extensionId = "bridge-check-extension";
const entry = resolve(import.meta.dir, process.env.TABRUNNER_SMOKE_ENTRY ?? "src/index.ts");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined),
  ),
  TABRUNNER_BRIDGE_PORT: String(port),
  TABRUNNER_BRIDGE_RUNTIME_DIR: runtimeDir,
  TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID: extensionId,
  TABRUNNER_BRIDGE_PING_MS: "150",
  TABRUNNER_BRIDGE_LEASE_MS: "1000",
  TABRUNNER_BRIDGE_IDLE_MS: "500",
};
const clients: Client[] = [];
const requests: BridgeRequest[] = [];
let socket: WebSocket | null = null;
let metadata: BrokerMetadata | null = null;
let brokerExited = false;
const closedClients: string[] = [];
let delayCleanup = false;
const deferredCleanup: BridgeRequest[] = [];
const statuses = new Map<string, ReturnType<typeof emptyStatus>>();
const observedRequests: BridgeRequest[] = [];
const syncRequests: BridgeRequest[] = [];
const syncBehavior = new Map<string, "fail" | "hold">();
const providerBehavior = new Map<string, "ready" | "fail" | "hold">();
const providerRequests: BridgeRequest[] = [];
let holdNextSync = false;
let helloCount = 0;
let heartbeatClients: string[] = [];

function check(label: string, ok: unknown): void {
  assert(ok, label);
  console.log(`  passed: ${label}`);
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  ms = 6_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}

function reply(request: BridgeRequest, result: unknown): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "response",
      clientId: request.clientId,
      requestId: request.requestId,
      ok: true,
      result,
    } satisfies ExtensionMessage),
  );
}

function rejectRequest(request: BridgeRequest): void {
  socket?.send(
    JSON.stringify({
      type: "response",
      clientId: request.clientId,
      requestId: request.requestId,
      ok: false,
      error: { code: "request-failed", message: "Test-only private failure detail" },
    } satisfies ExtensionMessage),
  );
}

function emit(
  clientId: string,
  runId: string | null,
  conversationId: string | null,
  event: CompactRunEvent,
): void {
  socket?.send(
    JSON.stringify({
      type: "event",
      clientId,
      runId,
      conversationId,
      event,
    } satisfies ExtensionMessage),
  );
}

async function request(method: string, clientId?: string): Promise<BridgeRequest> {
  return until(() => {
    const at = requests.findIndex(
      (r) => r.method === method && (!clientId || r.clientId === clientId),
    );
    return at < 0 ? undefined : requests.splice(at, 1)[0];
  }, `${method} request`);
}

function startClient(
  name: string,
  faultPreload?: string,
): {
  client: Client;
  transport: StdioClientTransport;
  connected: Promise<void>;
} {
  const client = new Client({ name, version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(faultPreload ? ["--preload", faultPreload] : []), entry],
    env,
    stderr: "inherit",
  });
  clients.push(client);
  return { client, transport, connected: client.connect(transport, { timeout: 10_000 }) };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 8_000 });
  if (!("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "<image>",
    )
    .join("\n");
}

async function connectExtension(protocolVersion = BRIDGE_PROTOCOL_VERSION): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `chrome-extension://${extensionId}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed"));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as DaemonMessage;
    if (msg.type === "ping") {
      heartbeatClients = msg.clientIds;
      ws.send(JSON.stringify({ type: "pong" } satisfies ExtensionMessage));
      return;
    }
    observedRequests.push(msg);
    if (msg.method === "sync") {
      syncRequests.push(msg);
      if (holdNextSync) {
        holdNextSync = false;
        syncBehavior.set(msg.clientId, "hold");
      }
      const behavior = syncBehavior.get(msg.clientId);
      if (behavior === "hold") return;
      if (behavior === "fail") {
        rejectRequest(msg);
        return;
      }
      ws.send(
        JSON.stringify({
          type: "response",
          clientId: msg.clientId,
          requestId: msg.requestId,
          ok: true,
          result: statuses.get(msg.clientId) ?? emptyStatus(),
        } satisfies ExtensionMessage),
      );
      return;
    }
    if (msg.method === "providerInfo") {
      providerRequests.push(msg);
      const behavior = providerBehavior.get(msg.clientId);
      if (behavior === "hold") return;
      if (behavior === "fail") {
        rejectRequest(msg);
        return;
      }
      const provider: BridgeProviderInfo =
        behavior === "ready"
          ? { name: "Test provider", ready: true, auth: "key", model: null }
          : { name: null, ready: false, auth: null, model: null };
      reply(msg, provider);
      return;
    }
    if (msg.method === "closeClient") {
      closedClients.push(msg.clientId);
      if (delayCleanup) deferredCleanup.push(msg);
      else reply(msg, { ok: true });
      return;
    }
    requests.push(msg);
  };
  helloCount++;
  ws.send(JSON.stringify({ type: "hello", extensionId, version: "0.14.2", protocolVersion }));
  return ws;
}

try {
  console.log("TabRunner shared MCP bridge check");
  const first = startClient("same display name", preload);
  const second = startClient("same display name");
  await Promise.all([first.connected, second.connected]);
  await Promise.all([first.client.listTools(), second.client.listTools()]);
  metadata = JSON.parse(await readFile(join(runtimeDir, `${port}.json`), "utf8")) as BrokerMetadata;
  check(
    "two simultaneous stdio clients discover one broker",
    metadata.pid !== first.transport.pid && metadata.pid !== second.transport.pid,
  );
  check(
    "runtime directory and token file are private",
    ((await stat(runtimeDir)).mode & 0o777) === 0o700 &&
      ((await stat(join(runtimeDir, `${port}.json`))).mode & 0o777) === 0o600,
  );
  check("all tools remain registered", (await first.client.listTools()).tools.length >= 23);
  await Bun.write(pingFault, "");
  await until(() => (existsSync(pingFailed) ? true : undefined), "one failed upstream ping");
  await Bun.sleep(200);
  check(
    "one failed upstream ping keeps the same downstream client usable",
    (await call(first.client, "health")).includes("side panel"),
  );
  check(
    "another client is unaffected by the failed ping",
    (await call(second.client, "health")).includes("side panel"),
  );
  check("offline health gives a fix", (await call(first.client, "health")).includes("side panel"));
  await Bun.write(bootstrapFault, "");
  const bootstrap = startClient("bootstrap recovery", preload);
  await bootstrap.connected;
  await until(() => (existsSync(bootstrapFailed) ? true : undefined), "failed upstream initialize");
  await Bun.sleep(200);
  check(
    "failed upstream initialization does not close an initialized downstream client",
    (await call(bootstrap.client, "health")).includes("side panel"),
  );
  await bootstrap.client.close();
  await Bun.write(pauseInitialize, "");
  const shuttingDown = startClient("shutdown during upstream initialization", preload);
  await shuttingDown.connected;
  await until(
    () => (existsSync(initializePaused) ? true : undefined),
    "paused upstream initialize",
  );
  const shuttingDownPid = shuttingDown.transport.pid;
  assert(shuttingDownPid);
  process.kill(shuttingDownPid, "SIGTERM");
  await until(
    () => {
      try {
        process.kill(shuttingDownPid, 0);
        return undefined;
      } catch {
        return true;
      }
    },
    "proxy shutdown cancels pending initialization",
    1_200,
  );
  check("shutdown cannot install a late upstream connection", true);
  await Bun.write(releaseInitialize, "");
  await shuttingDown.client.close();
  check(
    "offline mutations fail without hanging",
    (await call(first.client, "run", { task: "offline task" })).includes("isn't connected"),
  );

  let base = new URL(metadata.url);
  let auth = { authorization: `Bearer ${metadata.token}` };
  check("HTTP token is required", (await fetch(new URL("/health", base))).status === 401);
  check(
    "foreign HTTP Origin is rejected",
    (
      await fetch(new URL("/health", base), {
        headers: { ...auth, origin: "https://evil.example" },
      })
    ).status === 403,
  );
  check(
    "foreign Host is rejected",
    (await fetch(new URL("/health", base), { headers: { ...auth, host: "evil.example" } }))
      .status === 403,
  );
  check(
    "ordinary sites cannot open the extension socket",
    (await fetch(`http://127.0.0.1:${port}/ws`, { headers: { origin: "https://evil.example" } }))
      .status === 403,
  );
  check(
    "WebSocket upgrades are limited to /ws",
    (
      await fetch(`http://127.0.0.1:${port}/other`, {
        headers: { origin: `chrome-extension://${extensionId}` },
      })
    ).status === 404,
  );
  const mismatch = await connectExtension(1);
  await new Promise<void>((resolve) => {
    mismatch.onclose = () => resolve();
  });
  check(
    "old extension protocol is refused with an update instruction",
    (await call(first.client, "health")).includes("Update the extension"),
  );

  socket = await connectExtension();
  await Bun.sleep(100);
  const a = call(first.client, "run", { task: "client A private task" });
  let aAnswered = false;
  void a.then(() => {
    aAnswered = true;
  });
  const aRequest = await request("run");
  check(
    "a transient ping failure preserves the upstream session identity",
    aRequest.clientId === (await readFile(pingFailed, "utf8")),
  );
  socket.send(
    JSON.stringify({
      type: "response",
      clientId: "wrong-client",
      requestId: aRequest.requestId,
      ok: true,
      result: { runId: "wrong", conversationId: "wrong" },
    } satisfies ExtensionMessage),
  );
  await Bun.sleep(30);
  check("a response cannot claim another client's request", !aAnswered);
  emit(aRequest.clientId, "a1", "ca", { type: "started", runId: "a1", conversationId: "ca" });
  emit(aRequest.clientId, "a1", "ca", { type: "step", tool: "read", summary: "Early progress" });
  reply(aRequest, { runId: "a1", conversationId: "ca" });
  await a;
  check(
    "progress arriving before the receipt is preserved",
    (await call(first.client, "get_status", { wait: false })).includes("Early progress"),
  );
  const b = call(second.client, "run", { task: "client B private task" });
  const bRequest = await request("run");
  let currentBId = bRequest.clientId;
  reply(bRequest, { runId: "b1", conversationId: "cb" });
  await b;
  check(
    "display-name collisions still produce separate opaque owners",
    aRequest.clientId !== bRequest.clientId,
  );
  emit(aRequest.clientId, "a1", "ca", {
    type: "driving",
    tabId: 1,
    windowId: 1,
    title: "A private page",
  });
  emit(bRequest.clientId, "b1", "cb", {
    type: "driving",
    tabId: 2,
    windowId: 1,
    title: "B private page",
  });
  await Bun.sleep(50);
  const aStatus = await call(first.client, "get_status", { wait: false });
  const bStatus = await call(second.client, "get_status", { wait: false });
  check(
    "run statuses do not cross clients",
    aStatus.includes("A private page") &&
      !aStatus.includes("B private page") &&
      bStatus.includes("B private page") &&
      !bStatus.includes("A private page"),
  );
  const parked = call(first.client, "get_status", { waitSeconds: 5 });
  let woke = false;
  void parked.then(() => {
    woke = true;
  });
  await Bun.sleep(100);
  check("status waits while this client's run is quiet", !woke);
  emit(bRequest.clientId, "b1", "cb", { type: "step", tool: "read", summary: "B read" });
  await Bun.sleep(100);
  check("another client's event does not wake the wait", !woke);
  emit(aRequest.clientId, "old-a", "ca", { type: "done", summary: "stale answer" });
  emit(aRequest.clientId, "old-a", "ca", { type: "started", runId: "old-a", conversationId: "ca" });
  await Bun.sleep(100);
  check("stale run events cannot wake or replace current status", !woke);
  emit(aRequest.clientId, "a1", "ca", { type: "step", tool: "read", summary: "A read" });
  check("the owner's event wakes its wait", (await parked).includes("A read"));
  emit(aRequest.clientId, "a1", "ca", {
    type: "question",
    question: "Pay the invoice?",
    choices: ["Pay", "Not now"],
  });
  emit(aRequest.clientId, "a1", "ca", { type: "done", summary: "waiting" });
  await Bun.sleep(30);
  const question = await call(first.client, "get_status", { wait: false });
  check(
    "question and choices survive the following done",
    question.includes("state: question") && question.includes("Not now"),
  );

  const steer = call(second.client, "steer", { text: "Use the search" });
  const steerRequest = await request("steer");
  check(
    "controls target only the caller's exact current run",
    steerRequest.clientId === bRequest.clientId && steerRequest.runId === "b1",
  );
  reply(steerRequest, { ok: true });
  await steer;
  const cancel = call(second.client, "stop", { runId: "queued-exact-id" });
  const cancelRequest = await request("stop");
  check(
    "queued stop forwards only the requested run id",
    cancelRequest.clientId === bRequest.clientId && cancelRequest.runId === "queued-exact-id",
  );
  reply(cancelRequest, { stopped: true, panelBusy: false });
  check("stop returns its owner-scoped receipt", (await cancel).includes("Stopped"));

  const queued = call(second.client, "run", { task: "B queued task" });
  const queuedRequest = await request("run");
  reply(queuedRequest, { runId: "b2", conversationId: "cb", queued: 2 });
  check("queued receipt stays queued", (await queued).includes("Queued at position 2"));
  emit(bRequest.clientId, "b1", "cb", {
    type: "queue",
    queue: [
      { runId: "b2", conversationId: "cb", position: 2, task: "B queued task", owner: "bridge" },
    ],
  });
  emit(bRequest.clientId, "b2", "cb", { type: "started", runId: "b2", conversationId: "cb" });
  emit(bRequest.clientId, "b2", "cb", { type: "queue", queue: [] });
  emit(bRequest.clientId, "b2", "cb", { type: "done", summary: "B done" });
  await Bun.sleep(50);
  check(
    "queued runs get their own fresh status",
    (await call(second.client, "get_status", { wait: false })).includes("B done"),
  );

  await first.client.close();
  await until(
    () => (closedClients.includes(aRequest.clientId) ? true : undefined),
    "first client cleanup",
  );
  check("first proxy exit closes only its own session", !closedClients.includes(bRequest.clientId));
  check(
    "broker survives the first stdio client exit",
    (await second.client.listTools()).tools.length >= 23,
  );
  const direct = call(second.client, "browser_start", { goal: "B direct goal" });
  const directRequest = await request("browserStart");
  check(
    "display name is kept as metadata, not identity",
    directRequest.params.agent === "same display name" &&
      directRequest.clientId === bRequest.clientId,
  );
  reply(directRequest, {
    ok: true,
    runId: "bd",
    conversationId: "cb",
    data: { pageContent: "[ref=e1] button" },
  });
  await direct;
  const click = call(second.client, "browser_click", { ref: "e1", snapshot: false });
  const clickRequest = await request("browserAct");
  check(
    "direct actions carry owner and exact direct run",
    clickRequest.clientId === bRequest.clientId &&
      clickRequest.runId === "bd" &&
      clickRequest.params.snapshot === false,
  );
  statuses.set(bRequest.clientId, {
    ...emptyStatus(),
    runId: "bd",
    conversationId: "cb",
    state: "running",
    startedAt: Date.now(),
  });
  socket.close();
  check(
    "lost browser action reports uncertainty instead of retrying",
    (await click).includes("may already have changed"),
  );
  socket = await connectExtension();
  await Bun.sleep(100);
  check(
    "browser mutations are not replayed after reconnect",
    requests.filter((r) => r.method === "browserAct").length === 0,
  );
  check(
    "surviving client resyncs its own status",
    (await call(second.client, "get_status", { wait: false })).includes("state: running"),
  );

  const syncCount = (clientId: string) =>
    syncRequests.filter((r) => r.clientId === clientId).length;
  const mutationsBeforeRecovery = observedRequests.filter((r) =>
    ["run", "browserStart", "browserAct"].includes(r.method),
  ).length;
  providerBehavior.set(currentBId, "ready");
  syncBehavior.set(currentBId, "fail");
  let beforeSync = syncCount(currentBId);
  socket.close();
  socket = await connectExtension();
  await until(
    () => (syncCount(currentBId) > beforeSync ? true : undefined),
    "failed reconnect sync",
  );
  const failedSyncHealth = await call(second.client, "health");
  beforeSync = syncCount(currentBId);
  const recoveryHello = helloCount;
  statuses.set(currentBId, {
    ...statuses.get(currentBId)!,
    steps: [{ tool: "read", summary: "Recovered after failed sync" }],
  });
  syncBehavior.delete(currentBId);
  await until(
    () => (syncCount(currentBId) > beforeSync ? true : undefined),
    "heartbeat retries the failed sync without another hello",
  );
  const recoveredSyncStatus = await call(second.client, "get_status", { wait: false });
  check(
    "the same initialized client recovers after a failed sync without another hello",
    helloCount === recoveryHello &&
      recoveredSyncStatus.includes("Recovered after failed sync") &&
      !recoveredSyncStatus.includes("Last known status"),
  );
  check(
    "health cannot say Ready while this client's sync is failing",
    !failedSyncHealth.includes("Ready.") &&
      failedSyncHealth.includes("status") &&
      failedSyncHealth.includes("Fix:") &&
      !failedSyncHealth.includes("private failure detail"),
  );

  providerBehavior.set(currentBId, "fail");
  const failedProviderHealth = await call(second.client, "health");
  check(
    "a failed provider read is not Ready or an unconfigured provider",
    !failedProviderHealth.includes("Ready.") &&
      !failedProviderHealth.includes("none configured") &&
      failedProviderHealth.includes("provider") &&
      failedProviderHealth.includes("Fix:") &&
      !failedProviderHealth.includes("private failure detail"),
  );
  providerBehavior.set(currentBId, "hold");
  const timedOutProviderHealth = await call(second.client, "health");
  const delayedProvider = providerRequests.findLast((r) => r.clientId === currentBId);
  assert(delayedProvider);
  reply(delayedProvider, { name: "Late provider", ready: true, auth: "key", model: null });
  check("a timed-out provider lookup is not Ready", !timedOutProviderHealth.includes("Ready."));
  providerBehavior.delete(currentBId);
  check(
    "an unconfigured provider still gives its own setup instructions",
    (await call(second.client, "health")).includes("no provider is configured"),
  );
  providerBehavior.set(currentBId, "ready");
  check(
    "a successful provider lookup clears the earlier failure",
    (await call(second.client, "health")).includes("Ready."),
  );

  syncBehavior.set(currentBId, "hold");
  beforeSync = syncCount(currentBId);
  socket.close();
  socket = await connectExtension();
  await until(() => (syncCount(currentBId) > beforeSync ? true : undefined), "held reconnect sync");
  const timedOutSync = syncRequests.findLast((r) => r.clientId === currentBId);
  assert(timedOutSync);
  const timeoutHello = helloCount;
  let readsFinished = false;
  const statusReads = Promise.all([
    call(second.client, "get_status", { wait: false }),
    call(second.client, "get_status", { wait: false }),
  ]).then((result) => {
    readsFinished = true;
    return result;
  });
  await Bun.sleep(500);
  check(
    "heartbeats and concurrent status reads share one pending sync",
    syncCount(currentBId) === beforeSync + 1 && !readsFinished,
  );
  await until(
    () => (syncCount(currentBId) === beforeSync + 2 ? true : undefined),
    "heartbeat retries a timed-out sync",
  );
  const retriedSync = syncRequests.findLast((r) => r.clientId === currentBId);
  assert(retriedSync);
  statuses.set(currentBId, {
    ...statuses.get(currentBId)!,
    steps: [{ tool: "read", summary: "Recovered after timed-out sync" }],
  });
  syncBehavior.delete(currentBId);
  reply(retriedSync, statuses.get(currentBId));
  const timeoutRecoveryStatus = await call(second.client, "get_status", { wait: false });
  check(
    "a sync timeout recovers on the same socket without replaying browser work",
    helloCount === timeoutHello &&
      (await statusReads).every((body) => body.includes("Last known status")) &&
      timeoutRecoveryStatus.includes("Recovered after timed-out sync") &&
      !timeoutRecoveryStatus.includes("Last known status") &&
      observedRequests.filter((r) => ["run", "browserStart", "browserAct"].includes(r.method))
        .length === mutationsBeforeRecovery,
  );
  reply(timedOutSync, { ...emptyStatus(), state: "done", summary: "stale timed-out sync" });
  const healthySyncCount = syncCount(currentBId);
  await Bun.sleep(400);
  await call(second.client, "get_status", { wait: false });
  check(
    "a synchronized client gets no recurring status requests or late timeout overwrite",
    syncCount(currentBId) === healthySyncCount &&
      !(await call(second.client, "get_status", { wait: false })).includes("stale timed-out sync"),
  );

  syncBehavior.set(currentBId, "hold");
  beforeSync = syncCount(currentBId);
  socket.close();
  socket = await connectExtension();
  await until(() => (syncCount(currentBId) > beforeSync ? true : undefined), "event race sync");
  const staleSync = syncRequests.findLast((r) => r.clientId === currentBId);
  assert(staleSync);
  emit(currentBId, "bd", "cb", { type: "step", tool: "read", summary: "Newer live progress" });
  reply(staleSync, statuses.get(currentBId));
  const racedStatus = await call(second.client, "get_status", { wait: false });
  check(
    "a delayed sync cannot erase newer events from the same run",
    racedStatus.includes("Newer live progress") && racedStatus.includes("Last known status"),
  );
  statuses.set(currentBId, {
    ...statuses.get(currentBId)!,
    steps: [{ tool: "read", summary: "Newer live progress" }],
  });

  // The retry is still pending when the socket is replaced again.
  await until(
    () => (syncCount(currentBId) > beforeSync + 1 ? true : undefined),
    "event race retry remains pending",
  );
  const oldSocketSync = syncRequests.findLast((r) => r.clientId === currentBId);
  assert(oldSocketSync);
  beforeSync = syncCount(currentBId);
  socket.close();
  socket = await connectExtension();
  await until(
    () => (syncCount(currentBId) > beforeSync ? true : undefined),
    "replacement socket sync",
  );
  const newSocketSync = syncRequests.findLast((r) => r.clientId === currentBId);
  assert(newSocketSync);
  reply(oldSocketSync, { ...emptyStatus(), state: "done", summary: "stale socket sync" });
  syncBehavior.delete(currentBId);
  reply(newSocketSync, statuses.get(currentBId));
  check(
    "reconnect during sync ignores the old socket's result",
    (await call(second.client, "get_status", { wait: false })).includes("Newer live progress"),
  );

  holdNextSync = true;
  const pendingClose = startClient("close during sync");
  await pendingClose.connected;
  const closingSync = await until(
    () => syncRequests.find((r) => syncBehavior.get(r.clientId) === "hold"),
    "new client pending sync",
  );
  const closingSyncCount = syncCount(closingSync.clientId);
  await pendingClose.client.close();
  await until(
    () => (closedClients.includes(closingSync.clientId) ? true : undefined),
    "close during pending sync",
  );
  reply(closingSync, { ...emptyStatus(), state: "running", runId: "closed-run" });
  socket.close();
  socket = await connectExtension();
  await Bun.sleep(400);
  check(
    "closing a client during sync is terminal across heartbeats and reconnects",
    syncCount(closingSync.clientId) === closingSyncCount &&
      !heartbeatClients.includes(closingSync.clientId),
  );
  providerBehavior.delete(currentBId);

  statuses.set(bRequest.clientId, { ...emptyStatus(), conversationId: "cb" });
  socket.close();
  socket = await connectExtension();
  await Bun.sleep(100);
  const interruptedStatus = await call(second.client, "get_status", { wait: false });
  check(
    "a reconnect reports an interrupted task without assuming the worker restarted",
    interruptedStatus.includes("state: error") &&
      interruptedStatus.includes("could not resume the previous task after reconnecting") &&
      interruptedStatus.includes(
        "Do not repeat an action until you know whether it already happened",
      ) &&
      !interruptedStatus.includes("Chrome restarted"),
  );
  const reset = call(second.client, "new_conversation");
  const resetRequest = await request("newConversation");
  check(
    "worker restart clears stale run ids from later controls",
    resetRequest.runId === undefined && resetRequest.clientId === bRequest.clientId,
  );
  reply(resetRequest, { ok: true });
  await reset;

  const recovering = startClient("session recovery");
  await recovering.connected;
  const recoveryStart = call(recovering.client, "browser_start", { goal: "session recovery" });
  const recoveryRequest = await request("browserStart");
  reply(recoveryRequest, { ok: true, runId: "expired-direct", conversationId: "expired-chat" });
  await recoveryStart;
  check(
    "the test expires only its own upstream HTTP session",
    (
      await fetch(base, {
        method: "DELETE",
        headers: { ...auth, "mcp-session-id": recoveryRequest.clientId },
      })
    ).ok,
  );
  await until(
    () => (closedClients.includes(recoveryRequest.clientId) ? true : undefined),
    "expired upstream cleanup",
  );
  await Bun.sleep(400);
  check(
    "an expired upstream session reconnects and discloses its new identity",
    (await call(recovering.client, "health")).includes("This client has a new session"),
  );
  const resetExpired = call(recovering.client, "new_conversation");
  const resetExpiredRequest = await request("newConversation");
  check(
    "an expired session does not retain its old run controls",
    resetExpiredRequest.clientId !== recoveryRequest.clientId &&
      resetExpiredRequest.runId === undefined,
  );
  reply(resetExpiredRequest, { ok: true });
  await resetExpired;
  check(
    "upstream expiry leaves the simultaneous client usable",
    (await call(second.client, "health")).includes("connected: true"),
  );

  const expiredTransport = new StreamableHTTPClientTransport(new URL(metadata.url), {
    requestInit: { headers: auth },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const expired = new Client({ name: "lease-only", version: "0" });
  await expired.connect(expiredTransport);
  const expiredId = expiredTransport.sessionId;
  assert(expiredId);
  await until(
    () => (closedClients.includes(expiredId) ? true : undefined),
    "expired session cleanup",
  );
  check("lease expiry drains only the expired session", !closedClients.includes(bRequest.clientId));
  await expired.close();

  // A live mismatched broker must never be killed or replaced.
  const original = await readFile(join(runtimeDir, `${port}.json`), "utf8");
  const wrongVersion = JSON.stringify({ ...metadata, version: "other-version" });
  await Bun.write(join(runtimeDir, `${port}.json`), wrongVersion);
  const incompatible = startClient("wrong-version-check");
  await assert.rejects(incompatible.connected);
  await incompatible.client.close();
  check(
    "live version mismatch leaves the broker untouched",
    (await fetch(new URL("/health", base), { headers: auth })).ok,
  );
  await Bun.write(join(runtimeDir, `${port}.json`), original);

  const beforeRestart = call(second.client, "browser_start", { goal: "broker restart check" });
  const beforeRestartRequest = await request("browserStart");
  reply(beforeRestartRequest, {
    ok: true,
    runId: "before-broker-restart",
    conversationId: "cb",
  });
  await beforeRestart;
  const interrupted = call(second.client, "browser_click", { ref: "e1", snapshot: false });
  await request("browserAct", currentBId);
  const previousBroker = metadata;
  // Only this check's broker, discovered in its private runtime directory, is stopped.
  process.kill(previousBroker.pid, "SIGKILL");
  check(
    "a broker exit fails an in-flight action without replaying it",
    (await interrupted).includes("before repeating an action"),
  );
  metadata = await until(
    async () => {
      const fresh = JSON.parse(
        await readFile(join(runtimeDir, `${port}.json`), "utf8"),
      ) as BrokerMetadata;
      return fresh.token !== previousBroker.token ? fresh : undefined;
    },
    "replacement broker discovery",
    10_000,
  );
  base = new URL(metadata.url);
  auth = { authorization: `Bearer ${metadata.token}` };
  socket = await connectExtension();
  await Bun.sleep(200);
  const restartedStatus = await call(second.client, "get_status", { wait: false });
  check(
    "the same downstream client reports a fresh session after broker restart",
    restartedStatus.includes("This client has a new session") &&
      restartedStatus.includes("state: idle"),
  );
  const resetRestarted = call(second.client, "new_conversation");
  const resetRestartedRequest = await request("newConversation");
  check(
    "broker restart does not carry old run controls into the new owner",
    resetRestartedRequest.clientId !== currentBId && resetRestartedRequest.runId === undefined,
  );
  currentBId = resetRestartedRequest.clientId;
  reply(resetRestartedRequest, { ok: true });
  await resetRestarted;
  check(
    "another downstream client also recovers after the broker restart",
    (await call(recovering.client, "health")).includes("connected: true"),
  );
  check(
    "broker restart never replays browser mutations",
    requests.filter(
      (r) => r.method === "browserAct" || r.method === "browserStart" || r.method === "run",
    ).length === 0,
  );
  await recovering.client.close();

  delayCleanup = true;
  await second.client.close();
  await until(
    () => (deferredCleanup.some((r) => r.clientId === currentBId) ? true : undefined),
    "final cleanup request",
  );
  await Bun.sleep(700);
  check(
    "broker waits for cleanup before its idle grace",
    (await fetch(new URL("/health", base), { headers: auth })).ok,
  );
  for (const cleanup of deferredCleanup) reply(cleanup, { ok: true });
  delayCleanup = false;
  await until(() => {
    try {
      process.kill(metadata!.pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, "idle broker exit");
  brokerExited = true;
  check("broker exits after all clients and cleanup are gone", true);
  const unrelated = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: () => new Response("test-owned unrelated listener"),
  });
  try {
    const loser = Bun.spawn([process.execPath, entry, "--broker"], {
      env,
      stdout: "ignore",
      stderr: "inherit",
    });
    check(
      "a competing broker exits without replacing an unrelated listener",
      (await loser.exited) === 0 &&
        (await (await fetch(`http://127.0.0.1:${port}`)).text()) ===
          "test-owned unrelated listener",
    );
  } finally {
    await unrelated.stop(true);
  }
  console.log("All shared bridge checks passed");
} finally {
  delayCleanup = false;
  for (const cleanup of deferredCleanup) reply(cleanup, { ok: true });
  for (const client of clients) await client.close().catch(() => undefined);
  socket?.close();
  // This is the check's own broker PID, from its private runtime directory.
  if (metadata && !brokerExited) {
    try {
      process.kill(metadata.pid, "SIGTERM");
      await Bun.sleep(200);
      process.kill(metadata.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
  await rm(runtimeDir, { recursive: true, force: true });
}
