import { describe, it, expect, vi, afterEach } from "vitest";
import { createProvider } from "../factory";
import {
  ProviderError,
  isRetryable,
  type ChatMessage,
  type ResolvedProviderConfig,
  type ToolDef,
} from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

vi.mock("../credential", () => ({
  ensureProviderCredential: (config: unknown) => Promise.resolve(config),
}));

function makeConfig(over: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig {
  return {
    id: "chatgpt",
    name: "ChatGPT",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKey: "at-123",
    model: "gpt-5.4-mini",
    createdAt: 0,
    auth: {
      accessToken: "at-123",
      refreshToken: "rt",
      expiresAt: 0,
      chatgptAccountId: "acct-1",
    },
    ...over,
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

const frame = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}`;

async function captureBody(
  config: ResolvedProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<Record<string, unknown>> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(sseStream([frame({ type: "response.completed", response: {} })]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  for await (const delta of createProvider(config).stream(
    messages,
    tools,
    new AbortController().signal,
  )) {
    void delta;
  }
  const init = fetchSpy.mock.calls.at(-1)?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("Responses request bodies via @providerkit/core", () => {
  it("splits the system message into instructions and maps the rest to items", async () => {
    const body = await captureBody(
      makeConfig(),
      [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Do the thing." },
      ],
      [],
    );
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      instructions: "You are an agent.",
      stream: true,
      store: false,
    });
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Do the thing." }] },
    ]);
  });

  it("replays assistant turns WITHOUT reasoning (ChatGPT backend requires it blanked)", async () => {
    const body = await captureBody(
      makeConfig(),
      [
        { role: "user", content: "Look at the page." },
        {
          role: "assistant",
          content: "Let me click.",
          reasoning: "I should check the footer first",
          toolCalls: [{ id: "c1", name: "click", args: { ref: "e1" } }],
        },
        { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
      ],
      [],
    );
    const items = body.input as Record<string, unknown>[];
    expect(items).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain("reasoning");
    expect(items[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me click." }],
    });
    expect(items[2]).toEqual({
      type: "function_call",
      call_id: "c1",
      name: "click",
      arguments: '{"ref":"e1"}',
    });
    expect(items[3]).toEqual({ type: "function_call_output", call_id: "c1", output: "{}" });
  });

  it("maps tool results to function_call_output, with images as content parts", async () => {
    const body = await captureBody(
      makeConfig(),
      [
        { role: "user", content: "What's on screen?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "snapshot", args: {} },
            { id: "c2", name: "read", args: {} },
          ],
        },
        {
          role: "tool_results",
          content: "",
          toolResults: [
            { id: "c1", content: "{}", images: ["data:image/jpeg;base64,abc"] },
            { id: "c2", content: "plain result" },
          ],
        },
      ],
      [],
    );
    const items = body.input as { type: string; call_id: string; output: unknown }[];
    const outputs = items.filter((i) => i.type === "function_call_output");
    expect(outputs[0]?.output).toEqual([
      { type: "input_text", text: "{}" },
      { type: "input_image", image_url: "data:image/jpeg;base64,abc" },
    ]);
    expect(outputs[1]?.output).toBe("plain result");
  });

  it("omits the reasoning knob by default and with effort 'none', maps the rest", async () => {
    expect(await captureBody(makeConfig(), [], [])).not.toHaveProperty("reasoning");
    expect(await captureBody(makeConfig({ reasoningEffort: "none" }), [], [])).not.toHaveProperty(
      "reasoning",
    );
    const body = await captureBody(makeConfig({ reasoningEffort: "high" }), [], []);
    expect(body.reasoning).toMatchObject({ effort: "high" });
  });

  it("sends the picker's 'max' as 'high', the top level this shape takes", async () => {
    const body = await captureBody(makeConfig({ reasoningEffort: "max" }), [], []);
    expect(body.reasoning).toMatchObject({ effort: "high" });
  });

  it("serializes tools to Responses function definitions", async () => {
    const body = await captureBody(
      makeConfig(),
      [{ role: "user", content: "hi" }],
      [
        {
          name: "click",
          description: "Click an element",
          params: { type: "object", properties: {} },
        },
      ],
    );
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "click",
        description: "Click an element",
        parameters: { type: "object", properties: {} },
      }),
    ]);
  });
});

describe("ChatGPT provider SSE parsing", () => {
  it("parses text and reasoning deltas, then finishes on completed", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({ type: "response.reasoning_summary_text.delta", delta: "Let me" }),
          frame({ type: "response.reasoning_text.delta", delta: " look at" }),
          frame({ type: "response.output_text.delta", delta: "Hello" }),
          frame({ type: "response.output_text.delta", delta: " world" }),
          frame({
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5 } },
          }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);

    expect(deltas).toContainEqual({ type: "reasoning", text: "Let me" });
    expect(deltas).toContainEqual({ type: "reasoning", text: " look at" });
    expect(deltas).toContainEqual({ type: "text", text: "Hello" });
    expect(deltas).toContainEqual({ type: "text", text: " world" });
    expect(deltas).toContainEqual({ type: "usage", input: 10, output: 5, cacheRead: 0 });
    expect(deltas).toContainEqual({ type: "finish", reason: "stop" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
  });

  it("accumulates function-call arguments across deltas and emits one tool_use", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "click",
              arguments: "",
            },
          }),
          frame({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '{"ref":',
          }),
          frame({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '"e1"}',
          }),
          frame({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "click",
              arguments: '{"ref":"e1"}',
            },
          }),
          frame({ type: "response.completed", response: {} }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);

    const toolUse = deltas.find((d) => d.type === "tool_use");
    expect(toolUse).toEqual({ type: "tool_use", id: "call_1", name: "click", args: { ref: "e1" } });
    expect(deltas).toContainEqual({ type: "finish", reason: "tool_use" });
  });

  it("keeps the real call_id when output_item.added omits it and output_item.done supplies it", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc_1",
              name: "click",
              arguments: "",
            },
          }),
          frame({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '{"ref":"e1"}',
          }),
          frame({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_real_99",
              name: "click",
              arguments: '{"ref":"e1"}',
            },
          }),
          frame({ type: "response.completed", response: {} }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);

    const toolUse = deltas.find((d) => d.type === "tool_use");
    expect(toolUse).toEqual({
      type: "tool_use",
      id: "call_real_99",
      name: "click",
      args: { ref: "e1" },
    });
  });

  it("flushes a pending tool call whose done event was omitted by the terminal frame", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "click",
              arguments: '{"ref":"e1"}',
            },
          }),
          frame({ type: "response.completed", response: {} }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);

    expect(deltas).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: "click",
      args: { ref: "e1" },
    });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
  });

  it("maps a max_output_tokens incomplete to a length finish", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);

    expect(deltas).toContainEqual({ type: "finish", reason: "length" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
  });

  it("maps a content_filter incomplete to content_filter and throws retryable overload on other reasons", async () => {
    const provider = createProvider(makeConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.incomplete",
            response: { incomplete_details: { reason: "content_filter" } },
          }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const deltas = [];
    for await (const d of provider.stream([], [], new AbortController().signal)) deltas.push(d);
    expect(deltas).toContainEqual({ type: "finish", reason: "content_filter" });

    const error = await failureOf({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "server_busy" } },
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("overload");
    expect(isRetryable(error)).toBe(true);
  });

  async function failureOf(event: Record<string, unknown>): Promise<unknown> {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame(event)]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    try {
      for await (const d of createProvider(makeConfig()).stream(
        [],
        [],
        new AbortController().signal,
      ))
        void d;
    } catch (e) {
      return e;
    }
    throw new Error("expected the stream to throw");
  }

  it("retries a response.failed server error like any failed server", async () => {
    const error = await failureOf({
      type: "response.failed",
      response: {
        error: {
          code: "server_error",
          message: "An error occurred while processing your request.",
        },
      },
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("overload");
    expect(isRetryable(error)).toBe(true);
  });

  it("names a rate limit that arrives as an error event", async () => {
    const error = await failureOf({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Rate limit reached for gpt-5.4-mini on tokens per min (TPM).",
    });
    expect((error as ProviderError).kind).toBe("rate");
    expect(isRetryable(error)).toBe(true);
  });

  it("sends the bearer token and the ChatGPT-Account-Id header to the responses endpoint", async () => {
    const provider = createProvider(makeConfig());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame({ type: "response.completed", response: {} })]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    for await (const delta of provider.stream([], [], new AbortController().signal)) {
      void delta;
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers).toMatchObject({
      authorization: "Bearer at-123",
      "ChatGPT-Account-Id": "acct-1",
    });
  });

  it("keys ChatGPT's prompt cache on the conversation, in the header and the body alike", async () => {
    const provider = createProvider(makeConfig({ sessionId: "conv-1" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame({ type: "response.completed", response: {} })]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    for await (const delta of provider.stream([], [], new AbortController().signal)) {
      void delta;
    }

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(init.headers["session-id"]).toBe("conv-1");
    expect((JSON.parse(init.body) as { prompt_cache_key?: string }).prompt_cache_key).toBe(
      "conv-1",
    );
  });

  it("strips every pattern from a tool schema before it goes out", async () => {
    const provider = createProvider(makeConfig());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame({ type: "response.completed", response: {} })]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const tool = {
      name: "mcp__docs__create",
      description: "Create a document",
      params: {
        type: "object" as const,
        properties: {
          meta: {
            type: "object",
            properties: { slug: { type: "string", pattern: "^(?<slug>[a-z]+)$" } },
          },
        },
      },
    };

    for await (const delta of provider.stream([], [tool], new AbortController().signal)) {
      void delta;
    }

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(init.body).toContain('"slug":{"type":"string"}');
    expect(init.body).not.toContain("pattern");
  });

  it("sends OpenCode Go's session header when Muse is routed to Responses", async () => {
    const provider = createProvider(
      makeConfig({
        id: "opencode-go",
        name: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "go-key",
        model: "muse-spark-1.3-contributor",
        sessionId: "conv-1",
        auth: undefined,
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame({ type: "response.completed", response: {} })]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    for await (const delta of provider.stream([], [], new AbortController().signal)) {
      void delta;
    }

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(init.headers).toMatchObject({
      authorization: "Bearer go-key",
      "x-opencode-session": "conv-1",
    });
  });
});

describe("what a Responses call cost", () => {
  async function costOf(usage: Record<string, unknown>): Promise<number | undefined> {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseStream([
          frame({
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 5, ...usage } },
          }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const provider = createProvider(
      makeConfig({
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        auth: undefined,
      }),
    );
    let cost: number | undefined;
    for await (const d of provider.stream([], [], new AbortController().signal)) {
      if (d.type === "usage") cost = d.cost;
    }
    return cost;
  }

  it("takes a plain number and refuses a negative or a string", async () => {
    expect(await costOf({ cost: 0.002 })).toBe(0.002);
    expect(await costOf({ cost: -0.002 })).toBeUndefined();
    expect(await costOf({ cost: "0.002" })).toBeUndefined();
  });

  it("adds the upstream bill when the call ran on the caller's own key", async () => {
    expect(
      await costOf({
        cost: 0.0001,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.002 },
      }),
    ).toBeCloseTo(0.0021, 10);
  });
});
