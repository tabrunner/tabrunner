import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireStorageWatch } from "@/test-setup";
import { BRIDGE_LEASE_MS, bridgeConnected, bridgeItem, validBridgePort } from "../config";
import { BRIDGE_PROTOCOL_VERSION, bridgePorts, DEFAULT_BRIDGE_PORT } from "../protocol";
import type { BridgeHello, DaemonMessage } from "../protocol";
import { BridgeSocket } from "../ws-client";

const hello: BridgeHello = {
  type: "hello",
  extensionId: "test-extension",
  version: "0.0.0-test",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
};
const ready = { type: "ready", protocolVersion: BRIDGE_PROTOCOL_VERSION };
const ping = { type: "ping", clientIds: ["client-a"] };
const request = {
  type: "request",
  clientId: "client-a",
  requestId: "request-a",
  method: "sync",
  params: {},
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** A refused connection emits error and close, without having opened. */
  refuse(): void {
    this.onerror?.();
    this.close();
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const alarms = {
  create: vi.fn(() => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve(true)),
  onAlarm: { addListener: vi.fn<(listener: (alarm: { name: string }) => void) => void>() },
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("chrome", { ...chrome, alarms });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => vi.advanceTimersByTimeAsync(0);
const dialedPorts = () => FakeSocket.instances.map((socket) => Number(new URL(socket.url).port));

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("No WebSocket attempt");
  return socket;
}

async function fireAlarm(): Promise<void> {
  alarms.onAlarm.addListener.mock.calls[0]?.[0]({ name: "tabrunner-bridge" });
  await settle();
}

function start(hasActiveWork?: () => boolean) {
  const onMessage = vi.fn<(msg: DaemonMessage) => void>();
  const disconnected = vi.fn();
  const bridge = new BridgeSocket(onMessage, () => bridge.send(hello), disconnected, hasActiveWork);
  bridge.start();
  return { bridge, onMessage, disconnected };
}

async function enable(port = DEFAULT_BRIDGE_PORT, hasActiveWork?: () => boolean) {
  await bridgeItem.set({ enabled: true, port });
  const handlers = start(hasActiveWork);
  await settle();
  return handlers;
}

describe("BridgeSocket", () => {
  it("keeps the bridge off on a fresh install and clears a stale connected flag", async () => {
    await bridgeConnected.set(true);
    start();
    await settle();

    expect(alarms.clear).toHaveBeenCalledWith("tabrunner-bridge");
    expect(alarms.create).not.toHaveBeenCalled();
    expect(dialedPorts()).toEqual([]);
    expect(await bridgeConnected.get()).toBe(false);
  });

  it("sends hello at once but waits for ready before marking connected or passing traffic", async () => {
    const { bridge, onMessage, disconnected } = await enable(4_242);
    expect(alarms.create).toHaveBeenCalledWith("tabrunner-bridge", { periodInMinutes: 0.5 });
    const socket = latestSocket();
    expect(socket.url).toBe("ws://127.0.0.1:4242/ws");
    socket.open();
    bridge.send({ type: "pong" });
    await fireAlarm();
    expect(socket.sent).toEqual([hello]);
    expect(dialedPorts()).toEqual([4_242]);
    expect(await bridgeConnected.get()).toBe(false);

    socket.receive(ready);
    await settle();
    expect(await bridgeConnected.get()).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    socket.receive({ type: "ping", clientIds: null });
    socket.receive({ ...request, params: [] });
    socket.receive(ping);
    socket.receive(request);
    expect(onMessage.mock.calls).toEqual([[ping], [request]]);
    bridge.send({ type: "pong" });
    expect(socket.sent).toEqual([hello, { type: "pong" }]);
    socket.close();
    await settle();
    expect(await bridgeConnected.get()).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("accepts the first ping from an older compatible broker on the preferred port", async () => {
    const { onMessage } = await enable();
    latestSocket().open();
    latestSocket().receive(ping);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await bridgeConnected.get()).toBe(true);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(ping);
    expect(dialedPorts()).toEqual([DEFAULT_BRIDGE_PORT]);
  });

  it("skips an incompatible broker that closes after hello and requires ready on fallback ports", async () => {
    const { disconnected, onMessage } = await enable(4_242);
    const incompatible = latestSocket();
    incompatible.open();
    expect(incompatible.sent).toEqual([hello]);
    incompatible.close();

    const legacyOnFallback = latestSocket();
    legacyOnFallback.open();
    legacyOnFallback.receive(ping);
    expect(await bridgeConnected.get()).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();

    latestSocket().open();
    latestSocket().receive(ready);
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_244]);
    expect(await bridgeConnected.get()).toBe(true);
    expect(disconnected).not.toHaveBeenCalled();
  });

  it.each([
    ["a mismatched version", { ...ready, protocolVersion: BRIDGE_PROTOCOL_VERSION - 1 }],
    ["a missing version", { type: "ready" }],
    ["a malformed ping", { type: "ping", clientIds: [1] }],
    ["an early request", request],
  ])("tries the next port after %s without passing it to the handler", async (_label, frame) => {
    const { onMessage, disconnected } = await enable(4_242);
    latestSocket().open();
    latestSocket().receive(frame);

    expect(dialedPorts()).toEqual([4_242, 4_243]);
    expect(await bridgeConnected.get()).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("bounds both unopened and unconfirmed sockets and ignores late frames", async () => {
    const { disconnected, onMessage } = await enable(4_242);
    const unopened = latestSocket();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unopened.readyState).toBe(3);
    const unconfirmed = latestSocket();
    unconfirmed.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unconfirmed.readyState).toBe(3);
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_244]);

    unconfirmed.open();
    unconfirmed.receive(ready);
    unconfirmed.receive(request);
    expect(unconfirmed.sent).toEqual([hello]);
    expect(await bridgeConnected.get()).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("waits for the alarm after exhausting all ports and explains the outage once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await enable(4_242);
    for (let attempt = 0; attempt < 4; attempt++) latestSocket().refuse();
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_244, 4_245]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dialedPorts()).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);

    await fireAlarm();
    for (let attempt = 0; attempt < 4; attempt++) latestSocket().refuse();
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_244, 4_245, 4_242, 4_243, 4_244, 4_245]);
    const captions = info.mock.calls.filter(([, line]) =>
      String(line).includes("No compatible MCP broker"),
    );
    expect(captions).toHaveLength(1);
    expect(captions[0]?.[1]).toContain("127.0.0.1:4242");
  });

  it("fast-retries an accepted fallback first, then tries the rest without duplicates", async () => {
    const { disconnected } = await enable(4_242);
    latestSocket().refuse();
    const accepted = latestSocket();
    accepted.open();
    accepted.receive(ready);
    accepted.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_243]);

    for (let attempt = 0; attempt < 4; attempt++) latestSocket().refuse();
    expect(dialedPorts()).toEqual([4_242, 4_243, 4_243, 4_242, 4_244, 4_245]);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["work ends", "grace expires"])(
    "holds the last accepted slot until %s",
    async (release) => {
      let active = true;
      const { disconnected } = await enable(4_242, () => active);
      latestSocket().refuse();
      const accepted = latestSocket();
      accepted.open();
      accepted.receive(ready);
      accepted.close();
      await vi.advanceTimersByTimeAsync(2_000);
      latestSocket().refuse();
      await fireAlarm();
      latestSocket().refuse();
      expect(dialedPorts()).toEqual([4_242, 4_243, 4_243, 4_243]);
      expect(vi.getTimerCount()).toBe(0);

      if (release === "work ends") active = false;
      else await vi.advanceTimersByTimeAsync(BRIDGE_LEASE_MS - 2_000);
      await fireAlarm();
      latestSocket().refuse();
      expect(dialedPorts()).toEqual([4_242, 4_243, 4_243, 4_243, 4_243, 4_242]);
      expect(disconnected).toHaveBeenCalledOnce();
    },
  );

  it("does not dial out of the configured range while holding an active broker's slot", async () => {
    await enable(4_242, () => true);
    const accepted = latestSocket();
    accepted.open();
    accepted.receive(ready);
    fireStorageWatch("bridge", { enabled: true, port: 5_000 });
    await settle();
    accepted.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dialedPorts()).toEqual([4_242]);

    await vi.advanceTimersByTimeAsync(BRIDGE_LEASE_MS - 2_000);
    await fireAlarm();
    expect(dialedPorts()).toEqual([4_242, 5_000]);
  });

  it("keeps an accepted broker on alarm and port edits, then uses the new range on disconnect", async () => {
    await enable(4_242);
    const accepted = latestSocket();
    accepted.open();
    accepted.receive(ready);
    await fireAlarm();
    fireStorageWatch("bridge", { enabled: true, port: 5_000 });
    await settle();
    expect(dialedPorts()).toEqual([4_242]);
    expect(accepted.sent).toEqual([hello, { type: "pong" }, { type: "pong" }]);

    accepted.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dialedPorts()).toEqual([4_242, 5_000]);
  });

  it.each([false, true])("stops dialing when switched off (accepted: %s)", async (accepted) => {
    const { disconnected } = await enable(4_242);
    const socket = latestSocket();
    socket.open();
    if (accepted) socket.receive(ready);
    fireStorageWatch("bridge", { enabled: false, port: 4_242 });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.readyState).toBe(3);
    expect(await bridgeConnected.get()).toBe(false);
    expect(alarms.clear).toHaveBeenCalledWith("tabrunner-bridge");
    expect(dialedPorts()).toEqual([4_242]);
    expect(disconnected).toHaveBeenCalledTimes(accepted ? 1 : 0);

    fireStorageWatch("bridge", { enabled: true, port: 4_242 });
    await settle();
    expect(dialedPorts()).toEqual([4_242, 4_242]);
  });
});

describe("bridge ports", () => {
  it("offers four consecutive ports without exceeding the port limit", () => {
    expect(bridgePorts(DEFAULT_BRIDGE_PORT)).toEqual([17_836, 17_837, 17_838, 17_839]);
    expect(bridgePorts(65_534)).toEqual([65_534, 65_535]);
    expect(bridgePorts(65_535)).toEqual([65_535]);
  });

  it("accepts userland ports, not system ports or invalid numbers", () => {
    expect(validBridgePort(DEFAULT_BRIDGE_PORT)).toBe(true);
    expect(validBridgePort(1024)).toBe(true);
    expect(validBridgePort(65_535)).toBe(true);
    expect(validBridgePort(80)).toBe(false);
    expect(validBridgePort(70_000)).toBe(false);
    expect(validBridgePort(17_836.5)).toBe(false);
  });
});
