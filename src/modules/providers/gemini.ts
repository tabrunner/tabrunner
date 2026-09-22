import type { ChatProvider, ChatMessage, ToolDef, Delta, ResolvedProviderConfig } from "./types";
import {
  createGeminiProvider as createCoreGeminiProvider,
  ProviderError as CoreProviderError,
  parseToolArgs,
  toGeminiToolSchema,
  type ChatMessage as CoreMessage,
  type ImageMimeType,
  type ImagePart,
  type ToolDefinition as CoreTool,
} from "@providerkit/core";
import { envelopeProviderError, logCacheUsage } from "./http";
import { ProviderError } from "./types";

/**
 * Gemini-shape adapter — native Generative Language REST
 * (`POST {base}/models/{model}:streamGenerateContent`), through
 * @providerkit/core's provider. Deliberately NOT the OpenAI-compatible shim
 * (`…/v1beta/openai`): only the native endpoint carries thought signatures,
 * and dropping them breaks the model's chain across a tool round — the run
 * then spins on textless, call-less turns (each billing a full prompt) until
 * the step budget dies. pi and the opencode CLI both go native for the same
 * reason; the shim is fine for one-shot calls, not for an agent loop.
 *
 * This file is a TYPE bridge, nothing more: our loop speaks ChatMessage /
 * ToolDef / Delta, core speaks its own seam types. Every dialect fact
 * (thinking levels, signature replay, schema sanitizing) lives in core.
 */

/** Core appends `/v1beta` itself, so hand it the bare host. */
function coreBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1beta\/?$/, "");
}

/** Gemini's REST path takes the bare id — the picker often holds `models/x`. */
function bareModelId(model: string): string {
  return model.replace(/^models\//, "");
}

/** `data:image/png;base64,…` → core's image part; anything else is dropped. */
function toImagePart(url: string): ImagePart | undefined {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(url.trim());
  if (!match) return undefined;
  const mime = match[1];
  const data = match[2];
  if (!isImageMime(mime) || !data) return undefined;
  return { type: "image", mimeType: mime, data };
}

function isImageMime(mime: string | undefined): mime is ImageMimeType {
  return (
    mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif"
  );
}

/**
 * What each tool result answers — core's tool message wants the function
 * NAME, which our ToolResult doesn't carry. The call lives in the assistant
 * turn the results follow, so recover it from history; a result with no
 * matching call keeps its id as the name rather than failing the turn.
 */
function callNames(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const call of m.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

/** Wire history into core's message shape. Exported for tests. */
export function toCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  const names = callNames(messages);
  const out: CoreMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool_results") {
      for (const r of msg.toolResults ?? []) {
        const images: ImagePart[] = [];
        for (const url of r.images ?? []) {
          const part = toImagePart(url);
          if (part) images.push(part);
        }
        out.push({
          role: "tool",
          toolCallId: r.id,
          name: names.get(r.id) ?? r.id,
          content: r.content ?? "",
          ...(images.length > 0 ? { images } : {}),
        });
      }
      continue;
    }
    if (msg.role === "user" && msg.images?.length) {
      const parts: (
        { type: "text"; text: string } | { type: "image"; mimeType: ImageMimeType; data: string }
      )[] = [{ type: "text", text: msg.content }];
      for (const url of msg.images) {
        const part = toImagePart(url);
        if (part) parts.push(part);
      }
      out.push({ role: "user", content: parts });
      continue;
    }
    if (msg.role === "assistant") {
      out.push({
        role: "assistant",
        content: msg.content || "",
        ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
        ...(msg.toolCalls
          ? {
              toolCalls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.args),
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
              })),
            }
          : {}),
      });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

function toCoreTools(tools: ToolDef[]): CoreTool[] {
  // Sanitized for Gemini's dialect (nullable unions, numeric enums, const)
  // by core — the same pass opencode's transform applies before calling.
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object" as const, ...toGeminiToolSchema(t.params) },
  }));
}

/** Core chunks collapse into our deltas; tool fragments assemble by index. */
export function createGeminiProvider(config: ResolvedProviderConfig): ChatProvider {
  const core = createCoreGeminiProvider({
    apiKey: config.apiKey,
    model: bareModelId(config.model),
    ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
    baseUrl: coreBaseUrl(config.baseUrl),
    id: config.id,
  });
  return {
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      const toolAcc = new Map<
        number,
        { id: string; name: string; args: string; thoughtSignature?: string }
      >();
      try {
        for await (const chunk of core.createStream(toCoreMessages(messages), toCoreTools(tools), {
          signal,
        })) {
          if (chunk.type === "usage" && chunk.usage) {
            const input = chunk.usage.inputTokens ?? 0;
            const cached = chunk.usage.cachedInputTokens ?? 0;
            logCacheUsage(input, cached, chunk.usage.cacheWriteTokens ?? 0);
            yield {
              type: "usage",
              input,
              output: chunk.usage.outputTokens ?? 0,
              ...(cached ? { cacheRead: cached } : {}),
              ...(chunk.usage.cacheWriteTokens ? { cacheWrite: chunk.usage.cacheWriteTokens } : {}),
            };
            continue;
          }
          if (chunk.type === "finish" && chunk.finishReason) {
            yield { type: "finish", reason: mapFinishReason(chunk.finishReason) };
            continue;
          }
          if (chunk.type !== "delta") continue;
          if (chunk.reasoning) yield { type: "reasoning", text: chunk.reasoning };
          if (chunk.content) yield { type: "text", text: chunk.content };
          for (const tc of chunk.toolCalls ?? []) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx);
            if (acc) {
              if (tc.arguments) acc.args += tc.arguments;
              if (!acc.id && tc.id) acc.id = tc.id;
              if (!acc.name && tc.name) acc.name = tc.name;
              if (!acc.thoughtSignature && tc.thoughtSignature) {
                acc.thoughtSignature = tc.thoughtSignature;
              }
            } else {
              toolAcc.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.name ?? "",
                args: tc.arguments ?? "",
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
              });
            }
          }
        }
      } catch (e) {
        // A stopped run rejects here too, and that is not a failure.
        if (signal.aborted) throw e;
        throw normalizeCoreError(config, e);
      }

      // Flushed at stream end, like the OpenAI adapter: a dropped sentinel
      // must not swallow the turn's tool calls.
      for (const acc of toolAcc.values()) {
        yield {
          type: "tool_use",
          id: acc.id,
          name: acc.name,
          args: parseToolArgs(acc.args),
          ...(acc.thoughtSignature ? { thoughtSignature: acc.thoughtSignature } : {}),
        };
      }
      yield { type: "done" };
    },
  };
}

/**
 * Core's failure through OUR envelope, so Gemini errors read exactly like
 * every other provider's: the same classified lead lines (DataPolicy, auth
 * phrasings, plan gates), the same Details disclosure. Core already parsed
 * the wait (headers, RetryInfo) onto its error — keep it when the envelope
 * finds none of its own.
 */
function normalizeCoreError(config: ResolvedProviderConfig, e: unknown): unknown {
  if (!(e instanceof CoreProviderError)) return e;
  const status = e.status ?? 0;
  const enveloped = envelopeProviderError(
    { id: config.id, name: config.name },
    status,
    e.body ?? e.message,
    { detail: e.message },
  );
  if (enveloped.retryAfterMs === undefined && e.retryAfterMs !== undefined) {
    return new ProviderError(enveloped.message, status, enveloped.kind, e.retryAfterMs);
  }
  return enveloped;
}

function mapFinishReason(reason: string): "stop" | "length" | "tool_use" | "unknown" {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  return "unknown";
}
