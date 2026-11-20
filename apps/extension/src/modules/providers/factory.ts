import {
  createAnthropicProvider as createCoreAnthropicProvider,
  createGate,
  createGeminiProvider as createCoreGeminiProvider,
  createOpenAIProvider as createCoreOpenAIProvider,
  createResponsesProvider as createCoreResponsesProvider,
  EMPTY_USAGE,
  parseToolArgs,
  ProviderError as CoreProviderError,
  streamWatch,
  toGeminiToolSchema,
  withGate,
  withWatchdog,
  type ChatMessage as CoreMessage,
  type FinishReason as CoreFinishReason,
  type Gate,
  type ImageMimeType,
  type ImagePart,
  type Provider as CoreProvider,
  type ProviderChunk,
  type StreamOptions,
  type ToolDefinition as CoreTool,
} from "@providerkit/core";
import type {
  ChatMessage,
  ChatProvider,
  Delta,
  FinishReason,
  ResolvedProviderConfig,
  ToolDef,
} from "./types";
import { ProviderError } from "./types";
import { createAnthropicProvider as createClaudeOAuthProvider } from "./anthropic";
import { ensureProviderCredential } from "./credential";
import { logCacheUsage, normalizeCoreError, sessionHeaders } from "./http";
import { stampAntigravityUserAgent } from "./origin";
import { PRESETS } from "./presets";
import { assertChatProviderSupported } from "./status";
import { offerZenRead } from "./zen";

const MAX_CONCURRENT_PER_PROVIDER = 4;

/**
 * Six minutes without a chunk before giving up on a turn. Core's default
 * progress clock is five minutes; TabRunner keeps six to stay past any healthy
 * silent prefill measured upstream, and sets idleMs to the same ceiling so a
 * slow local model or buffered tool call is not cut at 60s.
 */
export const STREAM_STALL_MS = 6 * 60_000;

/**
 * One gate per provider connection, shared across every `createProvider` build
 * (the main run, auto-titler, memory extraction, compaction and skill
 * distillation) so concurrent background calls queue instead of hitting 429s.
 */
const gates = new Map<string, Gate>();

function gateFor(config: ResolvedProviderConfig): Gate {
  const key = `${config.id}:${config.baseUrl}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = createGate(MAX_CONCURRENT_PER_PROVIDER);
    gates.set(key, gate);
  }
  return gate;
}

/** Claude 4.5 ids have a 64K ceiling; newer adaptive Claude ids and proxies take 65536. */
const ANTHROPIC_EXTENDED_ONLY = /^claude-(opus|sonnet|haiku)-4-5(?:-\d{8})?$/;

function anthropicMaxTokens(model: string): number {
  return ANTHROPIC_EXTENDED_ONLY.test(model) ? 64_000 : 65_536;
}

/** Core appends `/v1beta` itself, so hand it the bare host. */
function geminiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1beta\/?$/, "");
}

/** Gemini's REST path takes the bare id; the picker often holds `models/x`. */
function bareGeminiModelId(model: string): string {
  return model.replace(/^models\//, "");
}

/** `data:image/png;base64,...` -> core's image part; anything else is dropped. */
export function toImagePart(url: string): ImagePart | undefined {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(url.trim());
  if (!match) return undefined;
  const mime = match[1];
  const data = match[2];
  if (!isImageMime(mime) || !data) return undefined;
  return { type: "image", mimeType: mime, data };
}

function fromImagePart(part: ImagePart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}

function isImageMime(mime: string | undefined): mime is ImageMimeType {
  return (
    mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif"
  );
}

/**
 * Recover each tool call's name from history so core's `tool` messages carry it
 * (required by Gemini's functionResponse). A result with no matching call keeps
 * its id as the name rather than failing the turn.
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
        | { type: "text"; text: string }
        | { type: "image"; mimeType: ImageMimeType; data: string }
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

function toCoreTools(tools: ToolDef[], shape: ResolvedProviderConfig["shape"]): CoreTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema:
      shape === "gemini"
        ? { type: "object" as const, ...toGeminiToolSchema(t.params) }
        : { ...t.params, type: "object" as const },
  }));
}

function mapFinishReason(reason: CoreFinishReason): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "content_filter";
  }
}

/**
 * Race a pre-request await (credential refresh, session header hashing, DNR
 * rule update) against the watchdog/caller signal so Stop or the stall
 * deadline can always unwind even when the awaited I/O accepts no signal.
 */
function unlessAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Build the underlying core Provider for one request's fresh config and headers. */
function buildCoreShapeProvider(
  config: ResolvedProviderConfig,
  extraHeaders: Record<string, string>,
): CoreProvider {
  const preset = PRESETS.find((p) => p.id === config.id);
  const effort = config.reasoningEffort;

  switch (config.shape) {
    case "openai":
      return createCoreOpenAIProvider({
        id: config.id,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        // TabRunner stores full versioned base URLs (e.g. .../v1, .../openai/v1)
        // or DeepSeek's bare host where /chat/completions sits at the root.
        path: "/chat/completions",
        ...(effort ? { effort } : {}),
        ...(preset?.effortDialect ? { effortDialect: preset.effortDialect } : {}),
        ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
      });

    case "anthropic": {
      // Coding-plan proxies (Kimi, Z.ai, QwenCloud) read Authorization: Bearer
      // while Anthropic reads x-api-key. Sending both lets each endpoint pick
      // its own; bearer: false sends x-api-key and headers adds Authorization.
      const authHeaders: Record<string, string> = config.auth
        ? {}
        : { Authorization: `Bearer ${config.apiKey}` };
      const headers = { ...authHeaders, ...extraHeaders };
      return createCoreAnthropicProvider({
        id: config.id,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        bearer: Boolean(config.auth),
        maxTokens: anthropicMaxTokens(config.model),
        ...(effort ? { effort } : {}),
        ...(effort === "none" && preset?.explicitNone ? { explicitNone: true } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }

    case "responses": {
      const headers: Record<string, string> = { ...extraHeaders };
      if (config.auth?.chatgptAccountId) {
        headers["ChatGPT-Account-Id"] = config.auth.chatgptAccountId;
      }
      return createCoreResponsesProvider({
        id: config.id,
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        path: "/responses",
        ...(effort && effort !== "none" ? { effort } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }

    case "gemini": {
      const model = bareGeminiModelId(config.model);
      return createCoreGeminiProvider({
        id: config.id,
        apiKey: config.apiKey,
        model,
        baseUrl: geminiBaseUrl(config.baseUrl),
        ...(effort ? { effort } : {}),
        ...(preset?.path ? { path: preset.path } : {}),
        ...(config.auth?.projectId ? { projectId: config.auth.projectId } : {}),
      });
    }
  }
}

/**
 * Wrap a core Provider builder so each request refreshes its credential and
 * builds its per-turn headers under the watchdog's signal, then streams through
 * core's adapter.
 */
function buildCoreProvider(base: ResolvedProviderConfig): CoreProvider {
  const preset = PRESETS.find((p) => p.id === base.id);
  const raw: CoreProvider = {
    id: base.id,
    model: base.model,
    async *createStream(messages, tools, opts: StreamOptions = {}) {
      const signal = opts.signal;
      const config = await unlessAborted(ensureProviderCredential(base), signal);
      const session = await unlessAborted(sessionHeaders(config.id, config.sessionId), signal);
      if (config.shape === "gemini" && config.id === "antigravity") {
        await unlessAborted(stampAntigravityUserAgent(bareGeminiModelId(config.model)), signal);
      }

      const headers: Record<string, string> = {
        ...session,
      };
      if (config.shape === "openai" && preset?.headers) {
        const last = messages[messages.length - 1];
        const turn = !last || last.role === "user" ? "user" : "agent";
        Object.assign(headers, preset.headers(turn));
      }

      const inner = buildCoreShapeProvider(config, headers);
      const sendSessionId =
        (config.shape === "responses" && preset?.responsesCacheKey) || config.shape === "gemini";
      const streamOpts: StreamOptions = {
        ...opts,
        ...(sendSessionId && config.sessionId ? { sessionId: config.sessionId } : {}),
      };
      yield* inner.createStream(messages, tools, streamOpts);
    },
  };

  // Gate sits outside the watchdog so queued calls never spend their stall
  // deadline waiting for a concurrency slot. requireContent is off because
  // TabRunner's loop owns its own empty-turn nudge and truncated-done recovery.
  const watched = withWatchdog(raw, {
    progressMs: STREAM_STALL_MS,
    idleMs: STREAM_STALL_MS,
    requireContent: false,
  });
  return withGate(watched, gateFor(base));
}

/**
 * Claude plan sign-in stays on the retained anthropic.ts adapter per decision 6:
 * do not recreate first-party client impersonation in a core decorator or shim.
 */
function usesRetainedClaudePlanAdapter(config: ResolvedProviderConfig): boolean {
  return config.shape === "anthropic" && config.id === "claude" && Boolean(config.auth);
}

/** Wrap the retained Claude plan adapter with the shared gate and stall watchdog. */
function wrapRetainedProvider(base: ResolvedProviderConfig, inner: ChatProvider): ChatProvider {
  const gate = gateFor(base);
  const stallMinutes = STREAM_STALL_MS / 60_000;
  return {
    stream(messages, tools, signal): AsyncIterable<Delta> {
      async function* guarded(): AsyncGenerator<Delta> {
        const release = await gate.acquire(signal);
        const watch = streamWatch({
          provider: base.id,
          progressMs: STREAM_STALL_MS,
          idleMs: STREAM_STALL_MS,
          signal,
        });
        try {
          signal.throwIfAborted();
          const iter = inner.stream(messages, tools, watch.signal)[Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = await unlessAborted(iter.next(), watch.signal);
              if (next.done) break;
              watch.sawByte();
              yield next.value;
            }
          } finally {
            iter.return?.().catch(() => {});
          }
        } catch (e) {
          if (signal.aborted) throw e;
          throw normalizeCoreError(base, watch.classify(e), stallMinutes);
        } finally {
          watch.dispose();
          release();
        }
      }
      return guarded();
    },
  };
}

/** Stream chunks from a core Provider into TabRunner's Delta stream. */
async function* streamFromCore(
  core: CoreProvider,
  config: ResolvedProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
): AsyncGenerator<Delta> {
  const coreMessages = toCoreMessages(messages);
  const coreTools = toCoreTools(offerZenRead(config, tools), config.shape);
  const toolAcc = new Map<
    number,
    { id: string; name: string; args: string; thoughtSignature?: string }
  >();
  let committed = false;
  const heldUsage: Delta[] = [];
  function* flushUsage(): Generator<Delta> {
    if (committed) return;
    committed = true;
    yield* heldUsage;
    heldUsage.length = 0;
  }

  try {
    for await (const chunk of core.createStream(coreMessages, coreTools, { signal })) {
      if (chunk.type === "usage" && chunk.usage) {
        const input = chunk.usage.inputTokens ?? 0;
        const cached = chunk.usage.cachedInputTokens ?? 0;
        logCacheUsage(input, cached, chunk.usage.cacheWriteTokens ?? 0);
        const usageDelta: Delta = {
          type: "usage",
          input,
          output: chunk.usage.outputTokens ?? 0,
          cacheRead: cached,
          ...(chunk.usage.cacheWriteTokens !== undefined
            ? { cacheWrite: chunk.usage.cacheWriteTokens }
            : {}),
          ...(chunk.usage.reportedCostUsd !== undefined
            ? { cost: chunk.usage.reportedCostUsd }
            : {}),
        };
        if (committed) yield usageDelta;
        else heldUsage.push(usageDelta);
        continue;
      }
      if (chunk.type === "finish" && chunk.finishReason) {
        yield* flushUsage();
        yield { type: "finish", reason: mapFinishReason(chunk.finishReason) };
        continue;
      }
      if (chunk.type !== "delta") continue;
      if (chunk.reasoning) {
        yield* flushUsage();
        yield { type: "reasoning", text: chunk.reasoning };
      }
      if (chunk.content) {
        yield* flushUsage();
        yield { type: "text", text: chunk.content };
      }
      for (const tc of chunk.toolCalls ?? []) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx);
        if (acc) {
          if (tc.arguments) acc.args += tc.arguments;
          if (!acc.id && tc.id) acc.id = tc.id;
          if (!acc.name && tc.name) acc.name = tc.name;
          if (!acc.thoughtSignature && tc.thoughtSignature)
            acc.thoughtSignature = tc.thoughtSignature;
        } else {
          toolAcc.set(idx, {
            id: tc.id ?? "",
            name: tc.name ?? "",
            args: tc.arguments ?? "",
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          });
        }
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
    throw normalizeCoreError(config, e, STREAM_STALL_MS / 60_000);
  }

  yield* flushUsage();
  for (const [idx, acc] of toolAcc.entries()) {
    yield {
      type: "tool_use",
      id: acc.id || `call_${idx}`,
      name: acc.name,
      args: parseToolArgs(acc.args),
      ...(acc.thoughtSignature ? { thoughtSignature: acc.thoughtSignature } : {}),
    };
  }
  yield { type: "done" };
}

/** Core messages -> TabRunner wire messages (retained Claude OAuth adapter + memory extraction). */
export function fromCoreMessages(messages: readonly CoreMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const result = {
        id: msg.toolCallId,
        content: msg.content,
        ...(msg.images?.length ? { images: msg.images.map(fromImagePart) } : {}),
      };
      const prev = out[out.length - 1];
      if (prev?.role === "tool_results") prev.toolResults = [...(prev.toolResults ?? []), result];
      else out.push({ role: "tool_results", content: "", toolResults: [result] });
      continue;
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        const text = msg.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const images = msg.content
          .filter((p): p is ImagePart => p.type === "image")
          .map(fromImagePart);
        out.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
      }
      continue;
    }
    if (msg.role === "assistant") {
      out.push({
        role: "assistant",
        content: msg.content,
        ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
        ...(msg.toolCalls?.length
          ? {
              toolCalls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                args: parseToolArgs(tc.arguments),
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
              })),
            }
          : {}),
      });
      continue;
    }
    out.push({ role: "system", content: msg.content });
  }
  return out;
}

/** Wrap a TabRunner ProviderError back in CoreProviderError so agents preserves metadata. */
function wrapAsCoreProviderError(
  id: string,
  normalized: ProviderError,
  raw?: CoreProviderError,
): CoreProviderError {
  return new CoreProviderError(id, normalized.kind ?? raw?.kind ?? "unknown", normalized.message, {
    status: normalized.status || raw?.status,
    retryAfterMs: normalized.retryAfterMs ?? raw?.retryAfterMs,
    resetAtMs: raw?.resetAtMs,
    window: raw?.window,
    shouldRetry: normalized.shouldRetry ?? raw?.shouldRetry,
    body: raw?.body,
    cause: normalized,
  });
}

/** Wrap a TabRunner ChatProvider (retained Claude OAuth or test stand-in) as a core Provider. */
export function asCoreProvider(
  provider: ChatProvider,
  id = "tabrunner",
  model = "chat",
): CoreProvider {
  return {
    id,
    model,
    async *createStream(messages, tools, opts: StreamOptions = {}): AsyncGenerator<ProviderChunk> {
      const signal = opts.signal ?? new AbortController().signal;
      const legacyTools: ToolDef[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        params: t.inputSchema,
      }));
      let sawToolCall = false;
      let finishReason: CoreFinishReason | undefined;
      let toolIndex = 0;
      try {
        for await (const delta of provider.stream(
          fromCoreMessages(messages),
          legacyTools,
          signal,
        )) {
          if (delta.type === "text") yield { type: "delta", content: delta.text };
          else if (delta.type === "reasoning") yield { type: "delta", reasoning: delta.text };
          else if (delta.type === "tool_use") {
            sawToolCall = true;
            yield {
              type: "delta",
              toolCalls: [
                {
                  index: toolIndex++,
                  id: delta.id,
                  name: delta.name,
                  arguments: JSON.stringify(delta.args),
                  ...(delta.thoughtSignature ? { thoughtSignature: delta.thoughtSignature } : {}),
                },
              ],
            };
          } else if (delta.type === "usage") {
            yield {
              type: "usage",
              usage: {
                ...EMPTY_USAGE,
                inputTokens: delta.input,
                outputTokens: delta.output,
                cachedInputTokens: delta.cacheRead ?? 0,
                ...(delta.cacheWrite !== undefined ? { cacheWriteTokens: delta.cacheWrite } : {}),
                ...(delta.cost !== undefined ? { reportedCostUsd: delta.cost } : {}),
              },
            };
          } else if (delta.type === "finish") {
            finishReason = delta.reason === "tool_use" ? "tool_calls" : delta.reason;
          }
        }
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ProviderError) throw wrapAsCoreProviderError(id, e);
        throw e;
      }
      yield { type: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") };
    },
  };
}

/** Factory: builds a gated, watchdog-guarded core Provider for @providerkit/agents. */
export function createCoreProvider(config: ResolvedProviderConfig): CoreProvider {
  assertChatProviderSupported(config);
  if (usesRetainedClaudePlanAdapter(config)) {
    return asCoreProvider(
      wrapRetainedProvider(config, createClaudeOAuthProvider(config)),
      config.id,
      config.model,
    );
  }
  const core = buildCoreProvider(config);
  const stallMinutes = STREAM_STALL_MS / 60_000;
  return {
    id: config.id,
    model: config.model,
    async *createStream(messages, tools, opts: StreamOptions = {}) {
      const shapedTools = toCoreTools(
        offerZenRead(
          config,
          tools.map((t) => ({ name: t.name, description: t.description, params: t.inputSchema })),
        ),
        config.shape,
      );
      try {
        for await (const chunk of core.createStream(messages, shapedTools, opts)) {
          if (chunk.type === "usage" && chunk.usage) {
            logCacheUsage(
              chunk.usage.inputTokens ?? 0,
              chunk.usage.cachedInputTokens ?? 0,
              chunk.usage.cacheWriteTokens ?? 0,
            );
          }
          yield chunk;
        }
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        const normalized = normalizeCoreError(config, e, stallMinutes);
        if (normalized instanceof ProviderError) {
          throw wrapAsCoreProviderError(
            config.id,
            normalized,
            e instanceof CoreProviderError ? e : undefined,
          );
        }
        throw normalized;
      }
    },
  };
}

/** Factory: builds a gated, watchdog-guarded provider on @providerkit/core. */
export function createProvider(config: ResolvedProviderConfig): ChatProvider {
  assertChatProviderSupported(config);
  if (usesRetainedClaudePlanAdapter(config)) {
    return wrapRetainedProvider(config, createClaudeOAuthProvider(config));
  }

  const core = buildCoreProvider(config);
  return {
    stream(messages, tools, signal): AsyncIterable<Delta> {
      return streamFromCore(core, config, messages, tools, signal);
    },
  };
}
