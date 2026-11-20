import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../loop";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import { createProvider, STREAM_STALL_MS } from "@/modules/providers/factory";
import type { ResolvedProviderConfig } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const snapshot = async (): Promise<SnapshotResult> => ({
  pageContent: "Page [ref=e1]",
  viewport: { width: 800, height: 600 },
  url: "https://example.com",
  title: "Example",
  newRefs: 0,
});

const driver = { snapshot } as unknown as BrowserDriver;

const config: ResolvedProviderConfig = {
  id: "test",
  name: "Test",
  shape: "openai",
  baseUrl: "https://example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  createdAt: 0,
};

let credentialWait: Promise<ResolvedProviderConfig> | null = null;
vi.mock("@/modules/providers/credential", () => ({
  ensureProviderCredential: (cfg: ResolvedProviderConfig) => credentialWait ?? Promise.resolve(cfg),
}));

function run(signal: AbortSignal) {
  const events = { done: 0, errors: [] as string[] };
  const finished = runAgentLoop({
    provider: createProvider(config),
    driver,
    task: "do it",
    signal,
    callbacks: {
      onDone: () => void events.done++,
      onError: (message) => void events.errors.push(message),
    },
  });
  return { events, finished };
}

afterEach(() => {
  credentialWait = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a model turn that never answers", () => {
  it("unwinds the moment Stop is pressed, even when a pre-request await ignores the signal", async () => {
    credentialWait = new Promise<ResolvedProviderConfig>(() => {});
    const controller = new AbortController();
    const { events, finished } = run(controller.signal);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();
    await finished;

    expect(events.done).toBe(1);
    expect(events.errors).toEqual([]);
  });

  it("gives up after the 6-minute stall deadline with a plain error, and does not replay the prompt", async () => {
    vi.useFakeTimers();
    let fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      fetches++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const { events, finished } = run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);

    await vi.advanceTimersByTimeAsync(STREAM_STALL_MS);
    await finished;

    expect(fetches).toBe(1);
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]).toContain("6 minutes");
  });

  it("gives up after the 6-minute stall deadline even after headers arrived, without replaying", async () => {
    vi.useFakeTimers();
    let fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      fetches++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () =>
              controller.error(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    });

    const { events, finished } = run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);

    await vi.advanceTimersByTimeAsync(STREAM_STALL_MS);
    await finished;

    expect(fetches).toBe(1);
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]).toContain("6 minutes");
  });

  it("retries when a usage-only chunk arrives before an in-band error, without committing the stream", async () => {
    const encoder = new TextEncoder();
    let fetches = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      fetches++;
      const lines =
        fetches === 1
          ? [
              `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } })}\n\n`,
              `data: ${JSON.stringify({ error: { code: 502, message: "upstream blip" } })}\n\n`,
            ]
          : [
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: { name: "done", arguments: '{"summary":"recovered"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              })}\n\n`,
              "data: [DONE]\n\n",
            ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    });

    const { events, finished } = run(new AbortController().signal);
    await finished;

    expect(fetches).toBe(2);
    expect(events.done).toBe(1);
    expect(events.errors).toEqual([]);
  });
});
