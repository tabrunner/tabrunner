import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../factory";
import type { ResolvedProviderConfig } from "../types";

function makeConfig(id = "go", baseUrl = "https://opencode.ai/zen/go/v1"): ResolvedProviderConfig {
  return {
    id,
    name: "OpenCode Go",
    shape: "openai",
    baseUrl,
    apiKey: "sk-test",
    model: "glm-5.3-flash",
    createdAt: 0,
  };
}

function heldSseResponse(): { response: Response; finish: () => void } {
  const encoder = new TextEncoder();
  let closeStream!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`),
      );
      closeStream = () => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      };
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    finish: () => closeStream(),
  };
}

describe("createProvider concurrency gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps concurrent streams at 4 across createProvider instances for the same provider and releases on completion, break or abort", async () => {
    const held: Array<{ finish: () => void }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const slot = heldSseResponse();
      held.push(slot);
      return slot.response;
    });

    const config = makeConfig("gate-test", "https://opencode.ai/zen/go/v1");
    // Five separate createProvider calls (main run, titler, memory extraction, etc.)
    const iters = Array.from({ length: 5 }, () => {
      const stream = createProvider({ ...config, sessionId: crypto.randomUUID() }).stream(
        [],
        [],
        new AbortController().signal,
      );
      return stream[Symbol.asyncIterator]();
    });

    // Start reading the first 4: all 4 reach fetch.
    const firstFour = await Promise.all(iters.slice(0, 4).map((it) => it.next()));
    expect(firstFour.every((r) => !r.done)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // The 5th waits at the gate without calling fetch.
    let fifthResolved = false;
    const fifthNext = iters[4]!.next().then((res) => {
      fifthResolved = true;
      return res;
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fifthResolved).toBe(false);

    // Early break on stream 0 releases its slot, letting stream 5 through.
    await iters[0]!.return?.();
    await fifthNext;
    expect(fifthResolved).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Aborting a stream held without reading further also frees its slot.
    const abortCtrl = new AbortController();
    const sixthStream = createProvider(config).stream([], [], abortCtrl.signal);
    const sixthIter = sixthStream[Symbol.asyncIterator]();
    let sixthResolved = false;
    const sixthNext = sixthIter.next().then((res) => {
      sixthResolved = true;
      return res;
    });
    await Promise.resolve();
    expect(sixthResolved).toBe(false);

    // Finish stream 1 to completion and drain it: its slot frees for stream 6.
    held[1]!.finish();
    while (!(await iters[1]!.next()).done) {
      // drain
    }
    await sixthNext;
    expect(sixthResolved).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(6);

    // Clean up remaining streams.
    abortCtrl.abort();
    for (const h of held.slice(2)) h.finish();
    for (const it of iters.slice(2)) await it.return?.();
  });
});
