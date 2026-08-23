import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { COMMANDS, runSlash } from "../ui/slash-commands";
import { appendMessageTo, setActiveConversation } from "../conversations";

/**
 * The panel's half of a compaction, against a fake port.
 *
 * The summary is written by the WORKER, into storage — and the panel watches
 * the conversation index and the run board, never a transcript. With no run in
 * flight nothing moves either of those, so the `compacted` event is the only
 * thing that can tell the panel to look. Miss it and the fold is invisible
 * until the next message happens to start a run, which is exactly the bug this
 * covers. The port drop is the other end of the same story: no event is ever
 * coming, so the live "Compacting…" row has to be taken down by hand.
 */

interface Fired {
  fireMessage: (e: Event) => void;
  fireDisconnect: () => void;
  posted: Command[];
}

function fakePort(): Fired {
  const message: Array<(e: Event) => void> = [];
  const disconnect: Array<() => void> = [];
  const posted: Command[] = [];
  const port = {
    name: PORT_NAME,
    postMessage: (cmd: Command) => void posted.push(cmd),
    onMessage: {
      addListener: (fn: (e: Event) => void) => message.push(fn),
      removeListener: () => {},
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnect.push(fn),
      removeListener: () => {},
    },
    disconnect: () => {},
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port as unknown as chrome.runtime.Port },
    tabs: { query: async () => [] },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  return {
    fireMessage: (e) => message.forEach((fn) => fn(e)),
    fireDisconnect: () => disconnect.forEach((fn) => fn()),
    posted,
  };
}

/** The store's storage reads settle in microtasks — one macrotask drains them. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

let port: Fired;

beforeEach(async () => {
  vi.useRealTimers();
  // The live port is module state in the store — without this the next case
  // reuses the previous one's fake and never sees its own listeners fire.
  useConversationStore.getState().disconnect();
  port = fakePort();
  await setActiveConversation("c1");
  await appendMessageTo("c1", {
    id: "u1",
    role: "user",
    content: "compare the three listings",
    timestamp: 1,
  });
  useConversationStore.setState({
    compactingSince: null,
    contextTokens: 0,
    status: "idle",
    deferred: null,
    pendingSend: null,
  });
  useConversationStore.getState().connect();
  await settled();
});

describe("a compaction the panel asked for", () => {
  it("pulls in the summary the worker wrote — nothing else would tell it to look", async () => {
    useConversationStore.getState().compact();
    expect(port.posted.some((c) => c.type === "compact")).toBe(true);
    expect(useConversationStore.getState().compactingSince).not.toBeNull();

    // The worker's write lands in storage while the panel shows its live row.
    await appendMessageTo("c1", {
      id: "s1",
      role: "summary",
      content: "1. Task: compare three listings…",
      timestamp: 2,
      compacted: { messages: 12, before: 18_400, after: 1_200 },
    });
    useConversationStore.setState({ contextTokens: 20_000 });
    port.fireMessage({ type: "compacted", messages: 12, before: 18_400, after: 1_200 });
    await settled();

    const state = useConversationStore.getState();
    expect(state.compactingSince).toBeNull();
    expect(state.messages.some((m) => m.role === "summary")).toBe(true);
    // The gauge moves when the work lands, not a turn later: 20k − (18.4k − 1.2k).
    expect(state.contextTokens).toBe(2_800);
  });

  it("asks the worker to drop it on Esc, and waits for the answer", async () => {
    useConversationStore.getState().compact();
    useConversationStore.getState().cancelCompact();

    // The abort is the worker's to perform — a local settle here would race a
    // summary that already landed in storage and leave it unfetched.
    expect(port.posted.some((c) => c.type === "cancel_compact")).toBe(true);
    expect(useConversationStore.getState().compactingSince).not.toBeNull();

    port.fireMessage({
      type: "compact_failed",
      message: "Compaction cancelled — nothing was folded.",
      nothing: true,
    });
    await settled();

    const state = useConversationStore.getState();
    expect(state.compactingSince).toBeNull();
    // A cancel is an answer, not a failure — no "Couldn't compact —" prefix.
    expect(state.messages.some((m) => m.content.startsWith("Compaction cancelled"))).toBe(true);
  });

  it("takes its own live row down when the worker dies mid-fold", async () => {
    useConversationStore.getState().compact();
    expect(useConversationStore.getState().compactingSince).not.toBeNull();

    port.fireDisconnect();
    await settled();

    const state = useConversationStore.getState();
    // Otherwise the shimmer keeps promising a fold nobody is doing.
    expect(state.compactingSince).toBeNull();
    expect(state.messages.some((m) => m.content.startsWith("Couldn't compact —"))).toBe(true);
  });
});

/**
 * /compact is the one command that cannot just fire: it costs a model call and
 * writes the transcript a live run is still writing. So it waits instead of
 * refusing — "come back later" would make the user remember and retype the
 * command they already typed.
 */
describe("/compact typed while a run works", () => {
  /** Through the real registry and the real gate — the deferral is enforced in
   *  runSlash, so a test that called store.compact() would prove nothing. */
  function typeCompact(): void {
    const command = COMMANDS.find((c) => c.name === "compact");
    if (!command) throw new Error("no /compact in COMMANDS");
    runSlash(command, undefined);
  }

  it("parks instead of firing, and goes when the run ends", async () => {
    useConversationStore.setState({ status: "running" });
    typeCompact();

    // Nothing crossed the port — a summary must not land under a live run.
    expect(port.posted.some((c) => c.type === "compact")).toBe(false);
    expect(useConversationStore.getState().deferred?.name).toBe("compact");

    port.fireMessage({ type: "done" });
    await settled();

    expect(port.posted.some((c) => c.type === "compact")).toBe(true);
    expect(useConversationStore.getState().deferred).toBeNull();
  });

  it("stays parked when the stop was a redirect — the next run is already committed", async () => {
    useConversationStore.setState({ status: "running" });
    typeCompact();
    // The composer's Stop with a queued line: the halt is a handoff, not an end.
    useConversationStore.setState({ pendingSend: "and the fourth listing too" });

    port.fireMessage({ type: "done" });
    await settled();

    // sendTask only reaches `running` after an await — a drain in that gap
    // would fold a conversation whose next task is already on its way.
    expect(port.posted.some((c) => c.type === "compact")).toBe(false);
    expect(useConversationStore.getState().deferred?.name).toBe("compact");
  });

  it("is take-back-able — the card's × drops it before it ever runs", async () => {
    useConversationStore.setState({ status: "running" });
    typeCompact();
    useConversationStore.getState().cancelDeferred();

    port.fireMessage({ type: "done" });
    await settled();

    expect(port.posted.some((c) => c.type === "compact")).toBe(false);
  });
});
