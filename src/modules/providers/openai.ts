import type {
  ChatProvider,
  ChatMessage,
  ToolDef,
  Delta,
  FinishReason,
  ProviderConfig,
  ResolvedProviderConfig,
} from "./types";
import { ensureProviderCredential } from "./credential";
import {
  apiUrl,
  effortParams,
  openRouterCostUsd,
  openRouterHostFor,
  parseToolArgs,
} from "@providerkit/core";
import {
  envelopeProviderError,
  logCacheUsage,
  promptCacheKey,
  providerHeaders,
  sessionHeaders,
  streamFrameError,
  streamSse,
} from "./http";
import { PRESETS } from "./presets";

/**
 * OpenAI-shape adapter — works with any OpenAI-compatible endpoint.
 * Streams SSE from POST /chat/completions.
 */
export function createOpenAIProvider(base: ResolvedProviderConfig): ChatProvider {
  return {
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      // Per request, not per run: a token that expires mid-run is renewed on the next turn.
      const config = await ensureProviderCredential(base);
      // Accumulate tool call args across chunks (OpenAI streams them in pieces)
      const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
      let ended = false;

      const stream = streamSse({
        url: apiUrl(config.baseUrl, "/chat/completions"),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...providerHeaders(config.id, messages),
          ...sessionHeaders(config.id, config.sessionId),
        },
        body: JSON.stringify(buildOpenAIBody(config, messages, tools)),
        provider: config,
        signal,
        // Usage comes AFTER the finish on this shape, so the reader keeps going
        // to `[DONE]`. A read that dies in between costs only the usage frame:
        // the answer is whole once its finish is stated.
        finished: () => ended,
        meta: {
          model: config.model,
          messages: messages.length,
          tools: tools.length,
          effort: config.reasoningEffort ?? "default",
        },
      });

      for await (const data of stream) {
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        if (chunk.error) throw streamFrameError(config, chunk.error);

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
          // With the caller's own key (BYOK), OpenRouter's `cost` is only its
          // fee: the kit adds the upstream bill, or prices nothing and the run
          // falls back to `tokenCost`. It also refuses anything that is not a
          // finite, non-negative number, because the run adds these up.
          const cost = openRouterCostUsd(chunk.usage);
          yield {
            type: "usage",
            input,
            output: chunk.usage.completion_tokens ?? 0,
            cacheRead: cached,
            // Gateways that price their own calls (OpenRouter); first-party
            // shapes leave it absent.
            ...(cost !== undefined ? { cost } : {}),
          };
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
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

        if (choice.finish_reason) {
          const stated = mapFinishReason(config, choice.finish_reason);
          ended = true;
          // Several gateways end a turn that called a tool on `stop`, and a
          // caller reading that as done never runs the tool. Only `stop` is
          // promoted: a length cut or a filter may be what broke the call.
          const reason = stated === "stop" && toolCallAccumulators.size > 0 ? "tool_use" : stated;
          yield { type: "finish", reason };
        }
      }

      // Flushed once the stream is over rather than on `[DONE]`: a gateway that
      // drops the sentinel — or a stream cut after the last argument fragment —
      // used to swallow every tool call of the turn, which reads as a model
      // that answered nothing.
      for (const acc of toolCallAccumulators.values()) {
        yield { type: "tool_use", id: acc.id, name: acc.name, args: parseToolArgs(acc.args) };
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

  // The gateway's server-side prompt cache, keyed per conversation — what pi
  // sends as `prompt_cache_key` on the same endpoint. Only the presets that
  // ask for the session header ever carry one.
  const cacheKey = promptCacheKey(config.id, config.sessionId);
  if (cacheKey) body.prompt_cache_key = cacheKey;

  if (tools.length > 0) {
    body.tools = tools.map(toOpenAITool);
  }

  // Verbatim passthrough — the provider validates per-model support (400 if
  // not) — except where the preset names a dialect of its own.
  const dialect = PRESETS.find((p) => p.id === config.id)?.effortDialect;
  if (dialect) {
    Object.assign(body, effortParams(dialect, config.reasoningEffort, config.model));
  } else if (config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort;
  }

  // OpenRouter picks a fresh upstream host per request, and the prompt cache
  // lives on that host, so the model's own vendor is pinned to keep it warm.
  const pin = openRouterHostFor(config.baseUrl, config.model);
  if (pin) {
    // allow_fallbacks keeps the pin a preference, not a lock: when the pinned
    // host can't serve, OpenRouter falls back — one cold miss, then back on the pin.
    body.provider = { order: [pin], allow_fallbacks: true };
  }

  return body;
}

interface OpenAIChunk {
  /** A failure after the 200 went out — see streamFrameError. */
  error?: unknown;
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
    /** OpenRouter-style gateways price the call at the source. Unchecked wire data. */
    cost?: unknown;
    /** OpenRouter: the call ran on the caller's own provider key. */
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: unknown } | null;
  };
}

/**
 * A stated finish, or a throw for one this dialect does not document. An
 * unknown reason (DeepSeek's `insufficient_system_resource`, Z.ai's
 * `network_error`, OpenRouter's `error`) says nothing about the answer being
 * whole, so it is thrown as a retryable `overload`.
 */
function mapFinishReason(
  provider: Pick<ProviderConfig, "id" | "name" | "auth">,
  reason: string,
): FinishReason {
  switch (reason) {
    // A natural end under another name: Together's `eos`, Hugging Face TGI's
    // `eos_token` and `stop_sequence`.
    case "stop":
    case "eos":
    case "eos_token":
    case "stop_sequence":
      return "stop";
    // Z.ai's `model_context_window_exceeded` and Mistral's `model_length`: the
    // context window filled before the answer did.
    case "length":
    case "model_context_window_exceeded":
    case "model_length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
    case "sensitive":
      return "content_filter";
    default:
      throw envelopeProviderError(provider, 200, `ended the turn on "${reason}"`, {
        unknownAs: "overload",
      });
  }
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
