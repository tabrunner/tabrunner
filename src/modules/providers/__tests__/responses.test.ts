import { describe, it, expect, vi, afterEach } from "vitest";
import { buildResponsesBody, createResponsesProvider } from "../responses";
import type { ResolvedProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

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

  it("omits the reasoning knob by default and with effort 'none', maps the rest", () => {
    expect(buildResponsesBody(makeConfig(), [], [])).not.toHaveProperty("reasoning");
    expect(buildResponsesBody(makeConfig({ reasoningEffort: "none" }), [], [])).not.toHaveProperty(
      "reasoning",
    );
    const body = buildResponsesBody(makeConfig({ reasoningEffort: "high" }), [], []);
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
});
