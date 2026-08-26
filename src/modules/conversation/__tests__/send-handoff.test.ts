import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { runModePref } from "@/lib/prefs";

/**
 * The dispatch seam in startRun: every await of a send runs against a live
 * port, but the worker can die before the post lands (MV3 idle kill, dev
 * reload). The port-drop recovery cannot cover that — onDisconnect fired
 * while this panel was still idle with lastRun null — so startRun owns the
 * dead post itself: resend once on a fresh connection (connecting starts a
 * stopped worker), and failing that, settle with an oriented bubble instead
 * of pinning the band on a run nobody received.
 *
 * Ports are a queue: runtime.connect hands out the next one and stays on the
 * last. A port with `dead` set throws synchronously from postMessage — the
 * exact pre-delivery semantics of posting to a disconnected port.
 */

interface FakePort {
  /** Commands that actually crossed — an attempted-but-thrown post never lands. */
  delivered: Command[];
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
  dead?: boolean;
}

let connections: FakePort[] = [];
const listeners = new WeakMap<FakePort, Array<(e: Event) => void>>();
const listenersOf = (p: FakePort) => listeners.get(p) ?? [];
const fire = (port: FakePort, e: Event) => listenersOf(port).forEach((fn) => fn(e));
/** What actually crossed the wire — attempts are invisible, like real Chrome. */
const postsOn = (p: FakePort) => p.delivered;

function makePort(dead = false): FakePort {
  const message: Array<(e: Event) => void> = [];
  const fake: FakePort = {
    name: PORT_NAME,
    delivered: [],
    postMessage: vi.fn<(cmd: Command) => void>((cmd: Command) => {
      if (fake.dead) throw new Error("Attempting to use a disconnected port");
      fake.delivered.push(cmd);
    }),
    onMessage: { addListener: (fn) => message.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
  listeners.set(fake, message);
  if (dead) fake.dead = true;
  return fake;
}

beforeEach(async () => {
  connections = [];
  await runModePref.set("background");
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      connect: () => {
        const next = connections.shift() ?? connections[connections.length - 1];
        return next as unknown as chrome.runtime.Port;
      },
    },
    tabs: { query: async () => [{ id: 1, url: "https://example.com", title: "Example" }] },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    conversations: [],
    activeId: null,
    status: "idle",
    streamingText: "",
    reasoningText: "",
    reasoningStartedAt: null,
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    lastRun: null,
    runMode: "background",
    pendingStepId: null,
    planMsgId: null,
    queued: [],
    pendingSend: null,
    draft: "",
    drivingTab: null,
  });
});
afterEach(() => useConversationStore.getState().disconnect());

describe("a dead port at dispatch time", () => {
  it("resends once on a fresh connection instead of pinning a fake run", async () => {
    const alive = makePort();
    const dying = makePort();
    connections = [alive, dying];
    const s = useConversationStore.getState();
    s.connect(); // takes `alive`

    await s.sendTask("original task");
    expect(postsOn(alive).at(-1)).toMatchObject({ type: "run", task: "original task" });
    expect(useConversationStore.getState().status).toBe("running");

    // The run ends; the worker quietly dies with its port — no disconnect
    // event fired yet (that is the hole this covers), and any further post
    // on the held connection throws pre-delivery.
    fire(alive, { type: "done", stopped: true } as unknown as Event);
    await Promise.resolve();
    expect(useConversationStore.getState().status).toBe("idle");

    // The redirect flight: sendTask keeps the held (now-dead) port, stores +
    // paints the message, and startRun's dispatch is the first thing to hit
    // the corpse.
    // The worker dies inside this panel's unwind window: no disconnect event
    // fires (the listener already ran, silently, while the panel was idle and
    // owed nothing), and the held connection starts rejecting posts.
    alive.dead = true;
    s.queueMessage("go back");
    s.stop();
    fire(alive, { type: "done", stopped: true } as unknown as Event);

    // The fresh connection also carries the reconnect handshake (query_run,
    // hello) — what matters: exactly ONE run crossed, and it is the redirect.
    await vi.waitFor(() =>
      expect(postsOn(dying).filter((c) => c.type === "run")).toEqual([
        expect.objectContaining({ type: "run", task: "go back" }),
      ]),
    );
    // Exactly one resend reached the fresh worker — never a double-send.
    expect(postsOn(alive).filter((c) => c.type === "run" && c.task === "go back")).toHaveLength(0);
    expect(useConversationStore.getState().messages.some((m) => m.content === "go back")).toBe(
      true,
    );
    // The band reflects a real claim, not a zombie.
    expect(useConversationStore.getState().status).toBe("running");
  });

  it("owns the loss with an error bubble and an idle band when reconnect fails too", async () => {
    const alwaysDead = makePort(true);
    connections = [alwaysDead];
    const s = useConversationStore.getState();
    s.connect();

    // First flight goes nowhere: attach succeeds, the store write lands, then
    // the dispatch throws — against a dead connection from the very start.
    await s.sendTask("doomed task");

    const state = useConversationStore.getState();
    expect(state.status).toBe("idle");
    expect(state.messages.some((m) => m.role === "error")).toBe(true);
    // Handshake commands ride the swallowed-catch paths and throw too (they
    // are recorded by the mock); what must never land is the run itself.
    expect(postsOn(alwaysDead).filter((c) => c.type === "run")).toHaveLength(0);
  });
});
