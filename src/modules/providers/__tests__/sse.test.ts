import { describe, it, expect, vi } from "vitest";
import { createOpenAIProvider } from "../openai";
import { createAnthropicProvider } from "../anthropic";
import { ProviderError, isRetryable, type ResolvedProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

function makeConfig(shape: "openai" | "anthropic", baseUrl: string): ResolvedProviderConfig {
  return {
    id: "test",
    name: "Test",
    shape,
    baseUrl,
    apiKey: "sk-test",
    model: "test-model",
    createdAt: 0,
  };
}

/** Build a ReadableStream from SSE lines. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n\n"));
      controller.close();
    },
  });
}

describe("OpenAI provider SSE parsing", () => {
  it("parses text deltas", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
          "data: [DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({ type: "text", text: "Hello" });
    expect(deltas).toContainEqual({ type: "text", text: " world" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
    vi.restoreAllMocks();
  });

  it("accumulates tool call args across chunks", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "click", arguments: '{"ref":' } },
                  ],
                },
              },
            ],
          })}`,
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"e1"}' } }] } }],
          })}`,
          "data: [DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    const toolUse = deltas.find((d) => d.type === "tool_use");
    expect(toolUse).toEqual({ type: "tool_use", id: "call_1", name: "click", args: { ref: "e1" } });
    vi.restoreAllMocks();
  });

  it("yields reasoning_content as reasoning, separate from text", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me check" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Answer" } }] })}`,
          "data: [DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({ type: "reasoning", text: "Let me check" });
    expect(deltas).toContainEqual({ type: "text", text: "Answer" });
    vi.restoreAllMocks();
  });

  it("classifies a 401 as an auth failure and leads the message with the fix", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("auth");
    // The provider's own name leads the message, not the wire shape ("OpenAI").
    expect((error as ProviderError).message).toContain("Test rejected the API key");
    // The raw body still rides along for the Details disclosure.
    expect((error as ProviderError).message).toContain("Unauthorized");
    // Retried as a probe — a real bad key says the same thing on every attempt.
    expect(isRetryable(error)).toBe(true);
    vi.restoreAllMocks();
  });

  it("turns a request that never left into a network kind, not a provider fault", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    expect(error).toBeInstanceOf(ProviderError);
    // Classified is the whole point: an unclassified failure logs at error
    // level, which is what fills chrome://extensions' Errors page.
    expect((error as ProviderError).kind).toBe("network");
    // No response happened, so there is no status to report.
    expect((error as ProviderError).status).toBe(0);
    // The host is named — the one token that diagnoses a typo'd base URL at a
    // glance. The raw browser string never reaches the user.
    expect((error as ProviderError).message).toContain("api.openai.com");
    expect((error as ProviderError).message).not.toContain("Failed to fetch");
    expect(isRetryable(error)).toBe(true);
    vi.restoreAllMocks();
  });

  it("lets a stopped run's own abort through untouched", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);
    const controller = new AbortController();

    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    });

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], controller.signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    // Stop is not an error: dressing it as a network failure would put a red
    // bubble on a run the user ended on purpose.
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as DOMException).name).toBe("AbortError");
    vi.restoreAllMocks();
  });

  it("classifies a quota-shaped 429 as permanent — never retried", async () => {
    const config = makeConfig("openai", "https://api.openai.com/v1");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
        { status: 429 },
      ),
    );

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    expect((error as ProviderError).kind).toBe("quota");
    expect(isRetryable(error)).toBe(false);
    vi.restoreAllMocks();
  });

  it("sends the session header on Zen turns carrying a conversation", async () => {
    const config: ResolvedProviderConfig = {
      ...makeConfig("openai", "https://opencode.ai/zen/v1"),
      id: "opencode",
      sessionId: "conv-1",
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream(["data: [DONE]"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    for await (const d of createOpenAIProvider(config).stream([], [], new AbortController().signal)) {
      void d;
    }
    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("conv-1");
    vi.restoreAllMocks();
  });

  it("words the data-policy gate as consent, never as a rejected key", async () => {
    const config: ResolvedProviderConfig = {
      ...makeConfig("openai", "https://opencode.ai/zen/go/v1"),
      id: "opencode-go",
    };
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        '{"type":"error","error":{"type":"DataPolicyError","message":"consentimento explícito: https://opencode.ai/workspace/wrk_abc/go"}}',
        { status: 403 },
      ),
    );

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    const err = error as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    // The fix is opening the consent page, not replacing a working key.
    expect(err.message).toContain("data policy");
    expect(err.message).toContain("https://opencode.ai/workspace/wrk_abc/go");
    expect(err.message).not.toContain("rejected the API key");
    expect(err.kind).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("words Z.ai's plan gate as entitlement, never as a rejected key", async () => {
    const config: ResolvedProviderConfig = {
      ...makeConfig("openai", "https://api.z.ai/api/anthropic"),
      id: "zai",
    };
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        '{"type":"error","error":{"type":"api_error","code":"1311","message":"[1311][当前订阅套餐暂未开放GLM-5.3-FlashX权限][20260922193547f2080868bec24d38]"}}',
        { status: 403 },
      ),
    );

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    const err = error as ProviderError;
    expect(err.kind).toBe("entitlement");
    expect(err.message).toContain("your plan doesn't include");
    expect(err.message).not.toContain("rejected the API key");
    vi.restoreAllMocks();
  });

  it("names Google's key rejection as auth and carves its wait out of RetryInfo", async () => {
    const config = makeConfig("openai", "https://generativelanguage.googleapis.com/v1beta/openai");
    const provider = createOpenAIProvider(config);

    const keySpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('[{"error":{"code":400,"message":"Please pass a valid API key"}}]', {
        status: 400,
      }),
    );
    const keyError = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();
    expect(keySpy).toHaveBeenCalled();
    expect((keyError as ProviderError).kind).toBe("auth");
    expect((keyError as Error).message).toContain("rejected the API key");
    vi.restoreAllMocks();

    const quotaSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            error: {
              code: 429,
              message: "You exceeded your current quota. Please retry in 3.3s.",
              status: "RESOURCE_EXHAUSTED",
              details: [{ retryDelay: "3s" }],
            },
          },
        ]),
        { status: 429 },
      ),
    );
    const quotaError = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();
    expect(quotaSpy).toHaveBeenCalled();
    expect((quotaError as ProviderError).kind).toBe("quota");
    // The 3-second wait survives on the error, so the loop can sleep it out
    // instead of failing a throttled turn outright.
    expect((quotaError as ProviderError).retryAfterMs).toBe(3000);
    expect(isRetryable(quotaError)).toBe(true);
    vi.restoreAllMocks();
  });

  it("words a multiturn-less model as a model problem, not a malformed request", async () => {
    const config = makeConfig("openai", "https://generativelanguage.googleapis.com/v1beta/openai");
    const provider = createOpenAIProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        '[{"error":{"code":400,"message":"Multiturn chat is not enabled for models/antigravity-preview-latest"}}]',
        { status: 400 },
      ),
    );
    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();
    expect((error as ProviderError).kind).toBe("model");
    vi.restoreAllMocks();
  });

  it("omits the session header without a conversation or off Zen", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sseStream(["data: [DONE]"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const noSession: ResolvedProviderConfig = {
      ...makeConfig("openai", "https://opencode.ai/zen/v1"),
      id: "opencode",
    };
    for await (const d of createOpenAIProvider(noSession).stream(
      [],
      [],
      new AbortController().signal,
    )) {
      void d;
    }
    const plain = makeConfig("openai", "https://api.openai.com/v1");
    for await (const d of createOpenAIProvider({ ...plain, sessionId: "conv-1" }).stream(
      [],
      [],
      new AbortController().signal,
    )) {
      void d;
    }
    for (const call of spy.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["x-opencode-session"]).toBeUndefined();
    }
    vi.restoreAllMocks();
  });
});

describe("Anthropic provider SSE parsing", () => {
  it("parses text deltas", async () => {
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({ type: "text", text: "Hello" });
    expect(deltas).toContainEqual({ type: "text", text: " world" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
    vi.restoreAllMocks();
  });

  it("counts cached input beside fresh input", async () => {
    // Anthropic's input_tokens is what was NOT cached — reads and writes are
    // reported separately. Take it at face value and the panel's token counter
    // collapses to a fraction of the truth the moment a cache starts hitting.
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({
            type: "message_start",
            message: {
              usage: {
                input_tokens: 300,
                cache_read_input_tokens: 9000,
                cache_creation_input_tokens: 700,
              },
            },
          })}`,
          `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({
      type: "usage",
      input: 10000,
      output: 42,
      cacheRead: 9000,
      cacheWrite: 700,
    });
    vi.restoreAllMocks();
  });

  it("reports input verbatim when nothing was cached", async () => {
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1234 } } })}`,
          `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({
      type: "usage",
      input: 1234,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
    });
    vi.restoreAllMocks();
  });

  it("parses tool use across content block lifecycle", async () => {
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: "click" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"ref":' } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '"e1"}' } })}`,
          `data: ${JSON.stringify({ type: "content_block_stop" })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    const toolUse = deltas.find((d) => d.type === "tool_use");
    expect(toolUse).toEqual({ type: "tool_use", id: "tu_1", name: "click", args: { ref: "e1" } });
    vi.restoreAllMocks();
  });

  it("yields thinking_delta as reasoning, separate from text", async () => {
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me check" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Answer" } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      deltas.push(d);
    }

    expect(deltas).toContainEqual({ type: "reasoning", text: "Let me check" });
    expect(deltas).toContainEqual({ type: "text", text: "Answer" });
    vi.restoreAllMocks();
  });

  it("classifies a plain 429 as rate limiting — still retryable", async () => {
    const config = makeConfig("anthropic", "https://api.anthropic.com");
    const provider = createAnthropicProvider(config);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );

    const error = await (async () => {
      try {
        for await (const delta of provider.stream([], [], new AbortController().signal)) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    expect((error as ProviderError).kind).toBe("rate");
    expect((error as ProviderError).message).toContain("rate-limiting");
    expect(isRetryable(error)).toBe(true);
    vi.restoreAllMocks();
  });
});
