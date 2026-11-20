import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../factory";
import { buildAnthropicBody } from "../anthropic";
import { PRESETS } from "../presets";
import type {
  ChatMessage,
  ExternalJsonSchema,
  ReasoningEffort,
  ResolvedProviderConfig,
  ToolDef,
} from "../types";

// Storage stand-in comes from src/test-setup.ts (vitest setupFiles).

vi.mock("../credential", () => ({
  ensureProviderCredential: (config: unknown) => Promise.resolve(config),
}));

afterEach(() => vi.restoreAllMocks());

const base: ResolvedProviderConfig = {
  id: "test",
  name: "Test",
  shape: "openai",
  baseUrl: "https://example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  createdAt: 0,
};

const messages: ChatMessage[] = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "Do the thing." },
];

function emptySseFor(shape: ResolvedProviderConfig["shape"]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload =
    shape === "anthropic"
      ? `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
      : shape === "responses"
        ? `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`
        : "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

async function captureBody(
  config: ResolvedProviderConfig,
  msgs: ChatMessage[],
  tools: ToolDef[] = [],
): Promise<Record<string, unknown>> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(emptySseFor(config.shape), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  const provider = createProvider(config);
  for await (const delta of provider.stream(msgs, tools, new AbortController().signal)) {
    void delta;
  }
  const init = fetchSpy.mock.calls.at(-1)?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("OpenAI request bodies via @providerkit/core", () => {
  it("omits reasoning_effort by default", async () => {
    const body = await captureBody(base, messages);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("maps reasoning_effort on OpenAI shape (max clamps to high in core)", async () => {
    const body = await captureBody({ ...base, reasoningEffort: "max" }, messages);
    expect(body.reasoning_effort).toBe("high");
  });

  it("serializes tool-call assistant turns with string content and echoed reasoning", async () => {
    const body = await captureBody(base, [
      { role: "user", content: "Do the thing." },
      {
        role: "assistant",
        content: "",
        reasoning: "let me look at the page",
        toolCalls: [{ id: "c1", name: "snapshot", args: {} }],
      },
      { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
    ]);
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning_content: "let me look at the page",
    });
    expect(msgs[1]?.tool_calls).toHaveLength(1);
  });

  it("never omits content on tool messages (strict deserializers 400 otherwise)", async () => {
    const body = await captureBody(base, [
      { role: "user", content: "Do the thing." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "type", args: { text: "hi" } }],
      },
      {
        role: "tool_results",
        content: "",
        // as unknown as string: reproducing the runtime hole the type misses.
        toolResults: [{ id: "c1", content: undefined as unknown as string }],
      },
    ]);
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "" });
    expect(JSON.stringify(msgs[2])).toContain('"content"');
  });

  describe("effort on the endpoints that spell it their own way", () => {
    async function effortFields(id: string, model: string, effort?: ReasoningEffort) {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) throw new Error(`no preset ${id}`);
      const wasDisabled = preset.disabled;
      delete preset.disabled;
      try {
        const body = await captureBody(
          {
            ...base,
            id,
            baseUrl: preset.baseUrl,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          },
          messages,
        );
        const { reasoning_effort, reasoning, thinking } = body;
        return { reasoning_effort, reasoning, thinking };
      } finally {
        if (wasDisabled) preset.disabled = true;
      }
    }

    it("OpenRouter: 'none' is said per measured model, never as a blanket off", async () => {
      const rows: Array<[string, string]> = [
        ["z-ai/glm-5.3-flash", "low"],
        ["openai/gpt-5-mini", "minimal"],
        ["xiaomi/mimo-v2.6-flash", "none"],
      ];
      for (const [model, effort] of rows) {
        expect(await effortFields("openrouter", model, "none"), model).toEqual({
          reasoning: { effort },
        });
      }
    });

    it("OpenRouter: 'none' to an unlisted model sends no field", async () => {
      expect(await effortFields("openrouter", "deepseek/deepseek-v4-flash", "none")).toEqual({});
    });

    it("OpenRouter: a named level rides in its own reasoning object, max included", async () => {
      for (const effort of ["low", "medium", "high", "max"] as const) {
        expect(await effortFields("openrouter", "z-ai/glm-5.3-flash", effort), effort).toEqual({
          reasoning: { effort },
        });
      }
    });

    it("DeepSeek: 'none' turns thinking off, because silence leaves it on", async () => {
      expect(await effortFields("deepseek", "deepseek-v4-flash", "none")).toEqual({
        thinking: { type: "disabled" },
      });
    });

    it("DeepSeek: low and medium cap it; high and max leave DeepSeek its own ceiling", async () => {
      expect(await effortFields("deepseek", "deepseek-v4-flash", "low")).toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "low",
      });
      for (const effort of ["high", "max"] as const) {
        expect(await effortFields("deepseek", "deepseek-v4-flash", effort), effort).toEqual({
          thinking: { type: "enabled" },
        });
      }
    });

    it("OpenCode Zen: 'none' is raised to what each family accepts, never sent as a 400", async () => {
      const none = (model: string) => effortFields("opencode", model, "none");
      expect(await none("minimax-m3.1-flash-free")).toEqual({ reasoning_effort: "low" });
      expect(await none("deepseek-v4.1-flash-free")).toEqual({ reasoning_effort: "low" });
      expect(await none("glm-5.3-flash-free")).toEqual({ reasoning_effort: "high" });
      expect(await effortFields("opencode", "big-pickle", "medium")).toEqual({
        reasoning_effort: "medium",
      });
    });

    it("sends nothing on any endpoint when no effort was picked", async () => {
      for (const [id, model] of [
        ["openrouter", "z-ai/glm-5.3-flash"],
        ["deepseek", "deepseek-v4-flash"],
        ["openai", "gpt-5.1"],
      ]) {
        expect(await effortFields(id!, model!), id).toEqual({});
      }
    });

    it("OpenAI keeps reasoning_effort verbatim: 'none' is one of its values", async () => {
      expect(await effortFields("openai", "gpt-5.1", "none")).toEqual({
        reasoning_effort: "none",
      });
    });
  });

  it("omits reasoning_content when the turn had no reasoning", async () => {
    const body = await captureBody(base, [{ role: "assistant", content: "done" }]);
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[0]).not.toHaveProperty("reasoning_content");
  });

  describe("OpenRouter upstream pinning", () => {
    const openrouter: ResolvedProviderConfig = {
      ...base,
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-5",
    };

    it("pins the model's own vendor when that vendor serves it", async () => {
      const body = await captureBody(openrouter, messages);
      expect(body.provider).toEqual({ order: ["anthropic"], allow_fallbacks: true });
    });

    it("maps vendor prefixes to their OpenRouter provider slug", async () => {
      const aliases: Record<string, string> = {
        "qwen/qwen3.8-flash": "alibaba",
        "mistralai/mistral-medium-3-5": "mistral",
        "x-ai/grok-4.6": "xai",
        "google/gemini-3.7-flash": "google-ai-studio",
        "z-ai/glm-5.3": "z-ai",
        "zai/glm-5.3": "z-ai",
      };
      for (const [model, slug] of Object.entries(aliases)) {
        const body = await captureBody({ ...openrouter, model }, messages);
        expect(body.provider, model).toEqual({ order: [slug], allow_fallbacks: true });
      }
    });

    it("leaves default routing on for vendors OpenRouter doesn't serve first-party", async () => {
      for (const model of ["meta-llama/llama-3.3-70b-instruct", "nvidia/nemotron-3.5-lightning"]) {
        const body = await captureBody({ ...openrouter, model }, messages);
        expect(body, model).not.toHaveProperty("provider");
      }
    });

    it("leaves default routing on for a model id without a vendor prefix", async () => {
      const body = await captureBody({ ...openrouter, model: "bare-model" }, messages);
      expect(body).not.toHaveProperty("provider");
    });

    it("never pins other OpenAI-shape endpoints: they are single-host", async () => {
      for (const baseUrl of ["https://api.groq.com/openai/v1", "https://api.deepseek.com"]) {
        const body = await captureBody(
          { ...base, baseUrl, model: "anthropic/claude-sonnet-5" },
          messages,
        );
        expect(body, baseUrl).not.toHaveProperty("provider");
      }
    });
  });
});

describe("Anthropic API-key request bodies via @providerkit/core", () => {
  const anthropicBase: ResolvedProviderConfig = {
    ...base,
    id: "anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-fable-5",
  };
  const tools: ToolDef[] = [
    {
      name: "snapshot",
      description: "Snapshot the page",
      params: { type: "object", properties: {} },
    },
  ];

  it("splits system out of the conversation and caches the conversation on tool turns", async () => {
    const body = await captureBody(anthropicBase, messages, tools);
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
    const msgs = body.messages as { role: string; content: { cache_control?: unknown }[] }[];
    expect(msgs[0]?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.max_tokens).toBe(65536);
  });

  it("caps Claude 4.5 models at 64000 tokens and maps adaptive Claude effort", async () => {
    const haiku = await captureBody(
      { ...anthropicBase, model: "claude-haiku-4-5-20251001" },
      messages,
    );
    expect(haiku.max_tokens).toBe(64000);

    const high = await captureBody({ ...anthropicBase, reasoningEffort: "high" }, messages);
    expect(high.thinking).toEqual({ type: "adaptive" });
    expect(high.output_config).toEqual({ effort: "high" });
  });

  it("turns thinking off on Z.ai when effort is none, and leaves default unset", async () => {
    const zai: ResolvedProviderConfig = {
      ...anthropicBase,
      id: "zai",
      baseUrl: "https://api.z.ai/api/anthropic",
      model: "glm-5.3-flash",
    };
    const none = await captureBody({ ...zai, reasoningEffort: "none" }, messages);
    expect(none.thinking).toEqual({ type: "disabled" });

    const unset = await captureBody(zai, messages);
    expect(unset).not.toHaveProperty("thinking");
  });

  it("merges back-to-back user messages (tool_results + injected mid-run note)", async () => {
    const body = await captureBody(anthropicBase, [
      { role: "user", content: "Do the thing." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "snapshot", args: {} }],
      },
      { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
      { role: "user", content: "also check the footer" },
    ]);
    const msgs = body.messages as { role: string; content: unknown[] }[];
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(msgs[2]?.content[1]).toMatchObject({ type: "text", text: "also check the footer" });
  });

  it("stays under the four-breakpoint cap on long conversations", async () => {
    const long: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "snapshot", args: {} }] },
      { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
      { role: "user", content: "and now the footer" },
    ];
    const body = await captureBody(anthropicBase, long, tools);
    const markers = JSON.stringify(body).match(/"cache_control"/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(4);
  });
});

describe("retained Claude plan sign-in adapter (buildAnthropicBody)", () => {
  const oauth: ResolvedProviderConfig = {
    ...base,
    id: "claude",
    name: "Claude",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-fable-5",
    auth: { accessToken: "at", refreshToken: "rt", expiresAt: 0 },
  };
  const tools: ToolDef[] = [
    {
      name: "snapshot",
      description: "Snapshot the page",
      params: { type: "object", properties: {} },
    },
  ];

  it("prepends the Claude Code identity as the first system block", () => {
    const body = buildAnthropicBody(oauth, messages, []);
    expect(body.system).toEqual([
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: "text", text: "You are an agent." },
    ]);
  });

  it("prefixes declared tool names with custom_ and anchors cache_control on the last system block", () => {
    const body = buildAnthropicBody(oauth, messages, tools);
    expect((body.tools as { name: string }[])[0]?.name).toBe("custom_snapshot");
    const blocks = body.system as { cache_control?: unknown }[];
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
  });
});

describe("external (remote MCP) tool schemas", () => {
  const schema: ExternalJsonSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
      filter: { anyOf: [{ type: "string" }, { type: "null" }], format: "custom" },
    },
    required: ["query"],
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
  const tools: ToolDef[] = [
    { name: "mcp__aboard__search", description: "Search.", params: schema },
  ];

  it("rides through OpenAI parameters with all keywords preserved", async () => {
    const body = await captureBody(base, messages, tools);
    expect(
      (body.tools as Array<{ function: { parameters: unknown } }>)[0]?.function.parameters,
    ).toEqual(schema);
  });

  it("rides through Anthropic input_schema", async () => {
    const body = await captureBody(
      { ...base, id: "anthropic", shape: "anthropic", baseUrl: "https://api.anthropic.com" },
      messages,
      tools,
    );
    expect(
      (body.tools as Array<{ input_schema: Record<string, unknown> }>)[0]?.input_schema,
    ).toMatchObject({
      type: "object",
      properties: schema.properties,
      required: ["query"],
    });
  });
});
