import { describe, it, expect, vi, afterEach } from "vitest";
import { buildResponsesBody, createResponsesProvider } from "../responses";
import { ProviderError, isRetryable, type ResolvedProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

// The seam is tested in credential.test.ts; here the config is already resolved.
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

afterEach(() => vi.restoreAllMocks());

describe("buildResponsesBody", () => {
  it("splits the system message into instructions and maps the rest to items", () => {
    const body = buildResponsesBody(
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

  it("replays assistant turns WITHOUT reasoning — the ChatGPT backend requires it blanked", () => {
    const body = buildResponsesBody(
      makeConfig(),
      [
        { role: "user", content: "Look at the page." },
        {
          role: "assistant",
          content: "Let me click.",
          reasoning: "I should check the footer first", // committed locally, never echoed
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

  it("maps tool results to function_call_output, with images as codex content parts", () => {
    const body = buildResponsesBody(
      makeConfig(),
      [
        { role: "user", content: "What's on screen?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "snapshot", args: {} }],
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

  it("trails screenshots in a user message for an endpoint that isn't codex's", () => {
    // The published Responses shape says function_call_output.output is a
    // string. Sending codex's content array to Meta would 400 every turn that
    // carried a screenshot — which, for a browser agent, is most of them.
    const body = buildResponsesBody(
      makeConfig({ id: "meta", baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3" }),
      [
        {
          role: "tool_results",
          content: "",
          toolResults: [{ id: "c1", content: "{}", images: ["data:image/jpeg;base64,abc"] }],
        },
      ],
      [],
    );
    const items = body.input as Record<string, unknown>[];
    expect(items[0]).toEqual({ type: "function_call_output", call_id: "c1", output: "{}" });
    expect(items[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Screenshot from the tool call above:" },
        { type: "input_image", image_url: "data:image/jpeg;base64,abc" },
      ],
    });
  });

  it("adds no trailing message when a tool result carried no images", () => {
    const body = buildResponsesBody(
      makeConfig({ id: "meta" }),
      [{ role: "tool_results", content: "", toolResults: [{ id: "c1", content: "done" }] }],
      [],
    );
    expect(body.input).toEqual([{ type: "function_call_output", call_id: "c1", output: "done" }]);
  });

  it("omits the reasoning knob by default and with effort 'none', maps the rest", () => {
    expect(buildResponsesBody(makeConfig(), [], [])).not.toHaveProperty("reasoning");
    expect(buildResponsesBody(makeConfig({ reasoningEffort: "none" }), [], [])).not.toHaveProperty(
      "reasoning",
    );
    const body = buildResponsesBody(makeConfig({ reasoningEffort: "high" }), [], []);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("sends the picker's 'max' as 'high', the top level this shape takes", () => {
    // @providerkit/core records a 400 for `max` on this shape (its responses.ts).
    const body = buildResponsesBody(makeConfig({ reasoningEffort: "max" }), [], []);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("serializes tools to Responses function definitions", () => {
    const body = buildResponsesBody(
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
      {
        type: "function",
        name: "click",
        description: "Click an element",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});

describe("ChatGPT provider SSE parsing", () => {
  it("parses text and reasoning deltas, then finishes on completed", async () => {
    const provider = createResponsesProvider(makeConfig());
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
    const provider = createResponsesProvider(makeConfig());
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

  it("flushes a pending tool call whose done event was omitted by the terminal frame", async () => {
    const provider = createResponsesProvider(makeConfig());
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
    const provider = createResponsesProvider(makeConfig());
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

  /**
   * A failure the backend reports after it answered 200. It threw before, but
   * as a bare status-0 error with no kind: never retried, and the reader got
   * the backend's English with no lead line.
   */
  async function failureOf(event: Record<string, unknown>): Promise<unknown> {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseStream([frame(event)]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    try {
      for await (const d of createResponsesProvider(makeConfig()).stream(
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
    const provider = createResponsesProvider(makeConfig());
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
      Authorization: "Bearer at-123",
      "ChatGPT-Account-Id": "acct-1",
    });
  });

  it("keys ChatGPT's prompt cache on the conversation, in the header and the body alike", async () => {
    // The backend shards its cache by session. Without the key a conversation's
    // turns land on different shards, and the prefix they re-send misses.
    const provider = createResponsesProvider(makeConfig({ sessionId: "conv-1" }));
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

  it("strips every `pattern` from a tool schema before it goes out", async () => {
    // The ChatGPT backend 400s the WHOLE request on a regex it cannot compile,
    // and a remote MCP server's tool schema can carry any regex it likes.
    const provider = createResponsesProvider(makeConfig());
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
    const provider = createResponsesProvider(
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
      Authorization: "Bearer go-key",
      "x-opencode-session": "conv-1",
    });
  });
});

/**
 * The adapter takes any base URL, so OpenRouter's `/responses` is one setting
 * away, and its closing usage carries `cost`, `is_byok` and `cost_details`
 * under the same names as chat. The run adds each call's cost to a running
 * total, so only a finite, non-negative number may reach it.
 */
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
    const provider = createResponsesProvider(
      makeConfig({ baseUrl: "https://openrouter.ai/api/v1" }),
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
