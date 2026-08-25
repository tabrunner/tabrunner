import { describe, it, expect } from "vitest";
import { buildOpenAIBody } from "../openai";
import { buildAnthropicBody } from "../anthropic";
import type {
  ChatMessage,
  ExternalJsonSchema,
  ResolvedProviderConfig,
  ToolDef,
} from "../types";

// Storage stand-in comes from src/test-setup.ts (vitest setupFiles).

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

describe("buildOpenAIBody", () => {
  it("omits reasoning_effort by default", () => {
    const body = buildOpenAIBody(base, messages, []);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("passes reasoning_effort through verbatim when set", () => {
    const body = buildOpenAIBody({ ...base, reasoningEffort: "max" }, messages, []);
    expect(body.reasoning_effort).toBe("max");
  });

  it("serializes tool-call assistant turns with string content and echoed reasoning", () => {
    // DeepSeek's strict deserializer reads null/absent content as a missing field,
    // and its thinking mode 400s unless reasoning_content is passed back verbatim.
    const body = buildOpenAIBody(
      base,
      [
        { role: "user", content: "Do the thing." },
        {
          role: "assistant",
          content: "",
          reasoning: "let me look at the page",
          toolCalls: [{ id: "c1", name: "snapshot", args: {} }],
        },
        { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
      ],
      [],
    );
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning_content: "let me look at the page",
    });
    expect(msgs[1]?.tool_calls).toHaveLength(1);
  });

  it("never omits `content` on tool messages (strict deserializers 400 otherwise)", () => {
    // A no-data tool (type, press_key, scroll) can produce content: undefined —
    // serializing that drops the key and DeepSeek rejects the body. The adapter
    // must always emit `content`, even when the result carried none.
    const body = buildOpenAIBody(
      base,
      [
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
      ],
      [],
    );
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "" });
    expect(JSON.stringify(msgs[2])).toContain('"content"');
  });

  it("omits reasoning_content when the turn had no reasoning", () => {
    const body = buildOpenAIBody(base, [{ role: "assistant", content: "done" }], []);
    const msgs = body.messages as Record<string, unknown>[];
    expect(msgs[0]).not.toHaveProperty("reasoning_content");
  });
});

describe("buildAnthropicBody", () => {
  const anthropicBase: ResolvedProviderConfig = { ...base, shape: "anthropic" };

  it("splits system out of the conversation", () => {
    const body = buildAnthropicBody(anthropicBase, messages, []);
    expect(body.system).toEqual([{ type: "text", text: "You are an agent." }]);
    expect(body.messages).toEqual([{ role: "user", content: "Do the thing." }]);
  });

  it("thinks adaptively by default, with no effort pinned", () => {
    // Unpinned used to send no thinking field at all, which on this shape reads
    // as reasoning off — quieter than the other two shapes' idea of "default".
    const body = buildAnthropicBody(anthropicBase, messages, []);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body).not.toHaveProperty("output_config");
  });

  it("keeps max_tokens above the thinking budget on every request", () => {
    // The gateways reject a cap that doesn't clear the budget they assign, and
    // thinking is now always on — so this can't be conditional on effort.
    for (const effort of [undefined, "none", "high"] as const) {
      const body = buildAnthropicBody(
        { ...anthropicBase, ...(effort ? { reasoningEffort: effort } : {}) },
        messages,
        [],
      );
      expect(body.max_tokens).toBeGreaterThan(32768);
    }
  });

  it("maps effort to adaptive thinking + output_config", () => {
    const body = buildAnthropicBody({ ...anthropicBase, reasoningEffort: "high" }, messages, []);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("lands 'none' on the same adaptive floor as default — no off switch exists", () => {
    const none = buildAnthropicBody({ ...anthropicBase, reasoningEffort: "none" }, messages, []);
    expect(none.thinking).toEqual({ type: "adaptive" });
    expect(none).not.toHaveProperty("output_config");
    // Deliberate, and the reason the picker shows two rows that agree on the
    // wire: if a way to disable thinking appears, this is the test to split.
    expect(none).toEqual(buildAnthropicBody(anthropicBase, messages, []));
  });

  it("merges back-to-back user messages (tool_results + injected mid-run note)", () => {
    // Anthropic rejects consecutive same-role messages; an injected user note
    // lands right after the tool_results user message and must merge into it.
    const body = buildAnthropicBody(
      anthropicBase,
      [
        { role: "user", content: "Do the thing." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "snapshot", args: {} }],
        },
        { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
        { role: "user", content: "also check the footer" },
      ],
      [],
    );
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "{}" },
      { type: "text", text: "also check the footer" },
    ]);
  });

  describe("in OAuth mode", () => {
    // A signed-in subscription provider — the adapter must wear Claude Code's
    // wire signatures: identity system block + custom_ tool-name prefix.
    const oauth: ResolvedProviderConfig = {
      ...anthropicBase,
      auth: { accessToken: "at", refreshToken: "rt", expiresAt: 0 },
    };
    const tools = [
      {
        name: "snapshot",
        description: "Snapshot the page",
        params: { type: "object" as const, properties: {} },
      },
    ];

    it("prepends the Claude Code identity as the first system block", () => {
      const body = buildAnthropicBody(oauth, messages, []);
      expect(body.system).toEqual([
        { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { type: "text", text: "You are an agent." },
      ]);
    });

    it("emits an identity block even when the conversation has no system message", () => {
      const body = buildAnthropicBody(oauth, [{ role: "user", content: "hi" }], []);
      expect((body.system as { text: string }[])[0]?.text).toContain("Claude Agent SDK");
    });

    it("prefixes declared tool names with custom_", () => {
      const body = buildAnthropicBody(oauth, messages, tools);
      expect((body.tools as { name: string }[])[0]?.name).toBe("custom_snapshot");
    });

    it("leaves key-based tool names unprefixed", () => {
      const body = buildAnthropicBody(anthropicBase, messages, tools);
      expect((body.tools as { name: string }[])[0]?.name).toBe("snapshot");
    });
  });

  describe("prompt caching", () => {
    const tools = [
      {
        name: "snapshot",
        description: "Snapshot the page",
        params: { type: "object" as const, properties: {} },
      },
    ];
    const oauth: ResolvedProviderConfig = {
      ...anthropicBase,
      auth: { accessToken: "at", refreshToken: "rt", expiresAt: 0 },
    };

    /** Every cache_control in the body, wherever it was placed. */
    const markers = (body: Record<string, unknown>) =>
      JSON.stringify(body).match(/"cache_control"/g) ?? [];

    it("anchors the fixed prefix on the last system block, not on the tools", () => {
      // Anthropic builds its prefix tools → system → messages, so one marker at
      // the end of `system` already covers the tool definitions above it —
      // spending a second on the tools array would buy nothing and the API caps
      // a request at four.
      for (const config of [anthropicBase, oauth]) {
        const body = buildAnthropicBody(config, messages, tools);
        const blocks = body.system as { cache_control?: unknown }[];
        expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
        expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
        expect(JSON.stringify(body.tools)).not.toContain("cache_control");
      }
    });

    it("rolls a second breakpoint onto the newest message", () => {
      const body = buildAnthropicBody(anthropicBase, messages, tools);
      const msgs = body.messages as { content: { cache_control?: unknown }[] }[];
      const tail = msgs[msgs.length - 1]?.content;
      expect(tail?.[tail.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    });

    it("stays under the four-breakpoint cap the API enforces", () => {
      const long: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "snapshot", args: {} }] },
        { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "{}" }] },
        { role: "user", content: "and now the footer" },
      ];
      expect(markers(buildAnthropicBody(oauth, long, tools)).length).toBeLessThanOrEqual(4);
    });

    it("marks nothing on a call that declares no tools", () => {
      // The four one-shot distillations — compact, memory extract, title, skill
      // — answer in a single turn and pass no tools. A marker there would bill
      // a 1.25x write against a cache that gets no second request to read it.
      const body = buildAnthropicBody(anthropicBase, messages, []);
      expect(markers(body)).toHaveLength(0);
    });
  });
});

describe("external (remote MCP) tool schemas", () => {
  // The widening contract: full JSON Schema from a remote server reaches both
  // wire shapes untouched. If an adapter ever starts rebuilding params instead
  // of assigning them, this is the test that fails first.
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

  it("rides through OpenAI parameters verbatim", () => {
    const body = buildOpenAIBody(base, messages, tools);
    expect((body.tools as Array<{ function: { parameters: unknown } }>)[0]?.function.parameters).toBe(schema);
  });

  it("rides through Anthropic input_schema verbatim", () => {
    const body = buildAnthropicBody({ ...base, shape: "anthropic" }, messages, tools);
    expect((body.tools as Array<{ input_schema: unknown }>)[0]?.input_schema).toBe(schema);
  });
});
