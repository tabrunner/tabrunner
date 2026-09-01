import type { ChatProvider, ChatMessage, ToolDef, Delta, ResolvedProviderConfig } from "./types";
import { apiUrl, logCacheUsage, parseToolArgs, streamSse } from "./http";

/**
 * OpenAI-shape adapter — works with any OpenAI-compatible endpoint.
 * Streams SSE from POST /chat/completions.
 */
export function createOpenAIProvider(config: ResolvedProviderConfig): ChatProvider {
  return {
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      // Accumulate tool call args across chunks (OpenAI streams them in pieces)
      const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();

      const stream = streamSse({
        url: apiUrl(config.baseUrl, "/chat/completions"),
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(buildOpenAIBody(config, messages, tools)),
        provider: config,
        signal,
        meta: {
          model: config.model,
          messages: messages.length,
          tools: tools.length,
          effort: config.reasoningEffort ?? "default",
        },
      });

      for await (const data of stream) {
        if (data === "[DONE]") {
          for (const acc of toolCallAccumulators.values()) {
            yield {
              type: "tool_use",
              id: acc.id,
              name: acc.name,
              args: parseToolArgs(acc.args),
            };
          }
          yield { type: "done" };
          return;
        }

        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Final usage chunk (stream_options.include_usage) — choices is empty
        if (chunk.usage) {
          const input = chunk.usage.prompt_tokens ?? 0;
          // This shape caches automatically off a stable prefix — nothing is
          // asked for and nothing is echoed back but this count, so it is the
          // only evidence the prefix is holding.
          const cached =
            chunk.usage.prompt_tokens_details?.cached_tokens ??
            // DeepSeek names the same slice itself and leaves the details
            // object empty — same number, its own field.
            chunk.usage.prompt_cache_hit_tokens ??
            0;
          logCacheUsage(input, cached);
          yield {
            type: "usage",
            input,
            output: chunk.usage.completion_tokens ?? 0,
            cacheRead: cached,
            // Gateways that price their own calls (OpenRouter) — rides through
            // verbatim; first-party shapes leave it absent.
            ...(chunk.usage.cost !== undefined ? { cost: chunk.usage.cost } : {}),
          };
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          yield { type: "finish", reason: mapFinishReason(choice.finish_reason) };
        }

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.reasoning_content) {
          yield { type: "reasoning", text: delta.reasoning_content };
        }

        if (delta.content) {
          yield { type: "text", text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCallAccumulators.get(idx);
            if (acc) {
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            } else {
              toolCallAccumulators.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? "",
                args: tc.function?.arguments ?? "",
              });
            }
          }
        }
      }

      yield { type: "done" };
    },
  };
}

/** Request body for POST /chat/completions. Exported for tests. */
export function buildOpenAIBody(
  config: ResolvedProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.flatMap(toOpenAIMessages),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools.length > 0) {
    body.tools = tools.map(toOpenAITool);
  }

  // Verbatim passthrough — the provider validates per-model support (400 if not).
  if (config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort;
  }

  const pin = openRouterHostFor(config.baseUrl, config.model);
  if (pin) {
    body.provider = { order: [pin], allow_fallbacks: true };
  }

  return body;
}

/**
 * OpenRouter's default routing picks a fresh upstream host per request, but the
 * prompt cache lives ON that host — so the stable prefix (system prompt, tools,
 * history) re-prefills cold every turn. Pinning the model's own vendor keeps
 * consecutive turns on one host, where its cache holds.
 *
 * Keys are model-id vendor prefixes whose vendor serves its own models on
 * OpenRouter; values are the provider slugs `order` accepts (checked against
 * OpenRouter's provider listing and each vendor's endpoint listings). Prefixes
 * not here — open-weight models served only by third parties (`meta-llama`,
 * `nvidia`, …), or a vendor added later — get no pin and keep default routing.
 */
const OPENROUTER_HOSTS: Record<string, string> = {
  anthropic: "anthropic",
  "arcee-ai": "arcee-ai",
  cohere: "cohere",
  deepseek: "deepseek",
  google: "google-ai-studio",
  meta: "meta",
  minimax: "minimax",
  mistralai: "mistral",
  moonshotai: "moonshotai",
  morph: "morph",
  openai: "openai",
  perplexity: "perplexity",
  qwen: "alibaba",
  stepfun: "stepfun",
  tencent: "tencent",
  upstage: "upstage",
  "x-ai": "xai",
  "z-ai": "z-ai",
};

/** The upstream slug an OpenRouter call should prefer, if the model's vendor serves it. */
function openRouterHostFor(baseUrl: string, model: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (host !== "openrouter.ai") return undefined;
  const vendor = model.split("/")[0]?.toLowerCase();
  // allow_fallbacks (sent by buildOpenAIBody) keeps the pin a preference, not
  // a lock: when the pinned host can't serve, OpenRouter falls back — one cold
  // miss, then back on the pin.
  return vendor ? OPENROUTER_HOSTS[vendor] : undefined;
}

interface OpenAIChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string;
      /** DeepSeek/Kimi/GLM-style reasoning stream — present on thinking models */
      reasoning_content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek's own name for the cached slice. */
    prompt_cache_hit_tokens?: number;
    /** OpenRouter-style gateways price the call at the source. */
    cost?: number;
  };
}

function mapFinishReason(reason: string): "stop" | "length" | "tool_use" | "unknown" {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return "unknown";
}

type OpenAIPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIPart[];
  /** Thinking-mode reasoning echoed back — DeepSeek 400s without it; others ignore it. */
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

function imageParts(images: string[]): OpenAIPart[] {
  return images.map((url) => ({ type: "image_url" as const, image_url: { url } }));
}

export function toOpenAIMessages(msg: ChatMessage): OpenAIMessage[] {
  if (msg.role === "tool_results") {
    // OpenAI: one role:tool message per result
    const results = msg.toolResults ?? [];
    const messages: OpenAIMessage[] = results.map((r) => ({
      role: "tool" as const,
      // A `content` key that drops out of the JSON is a 400 on strict
      // deserializers (DeepSeek: "missing field content") — always emit it.
      content: r.content ?? "",
      tool_call_id: r.id,
    }));
    // A role:tool message may only carry text, so screenshots ride along in a
    // trailing user message — the same turn, just the only slot that accepts them.
    const images = results.flatMap((r) => r.images ?? []);
    if (images.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Screenshot from the tool call above:" },
          ...imageParts(images),
        ],
      });
    }
    return messages;
  }
  if (msg.role === "user" && msg.images?.length) {
    return [
      { role: "user", content: [{ type: "text", text: msg.content }, ...imageParts(msg.images)] },
    ];
  }
  if (msg.role === "assistant") {
    // Never null — DeepSeek's strict deserializer reads it as a missing field.
    const out: OpenAIMessage = { role: "assistant", content: msg.content || "" };
    if (msg.reasoning) out.reasoning_content = msg.reasoning;
    if (msg.toolCalls) {
      out.tool_calls = msg.toolCalls.map((tc): OpenAIToolCall => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    }
    return [out];
  }
  return [{ role: msg.role, content: msg.content }];
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function toOpenAITool(tool: ToolDef) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.params,
    },
  };
}
