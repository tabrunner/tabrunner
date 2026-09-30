import type {
  ChatProvider,
  ChatMessage,
  Delta,
  ReasoningEffort,
  ResolvedProviderConfig,
  ToolDef,
} from "./types";
import { REASONING_EFFORTS } from "./types";
import { apiUrl, parseToolArgs } from "@providerkit/core";
import {
  anthropicHeaders,
  anthropicOAuthHeaders,
  logCacheUsage,
  sessionHeaders,
  streamFrameError,
  streamSse,
} from "./http";
import { PRESETS } from "./presets";

/**
 * Claude Code identities the subscription token as theirs, so OAuth traffic
 * must wear its two signatures: a `custom_` tool-name prefix (the server
 * strips it before the model sees the name) and a first system block naming
 * the agent SDK.
 */
const CLAUDE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const TOOL_PREFIX = "custom_";

/** Anthropic-shape adapter — streams SSE from POST /v1/messages. */
export function createAnthropicProvider(config: ResolvedProviderConfig): ChatProvider {
  return {
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      let toolCallBuffer: { id: string; name: string; args: string } | null = null;
      let freshInput = 0;
      let cacheRead = 0;
      let cacheWritten = 0;

      const stream = streamSse({
        url: apiUrl(config.baseUrl, "/v1/messages"),
        // A signed-in subscription provider sends the access token as a Bearer
        // and talks OAuth-token mode; a key provider sends x-api-key. Gateway
        // rows routed here (OpenCode Zen/Go Claude models) also carry the
        // per-conversation session header — same rule as the other adapters.
        headers: {
          ...(config.auth ? anthropicOAuthHeaders(config.apiKey) : anthropicHeaders(config.apiKey)),
          ...sessionHeaders(config.id, config.sessionId),
        },
        body: JSON.stringify(buildAnthropicBody(config, messages, tools)),
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
        let event: AnthropicSSE;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case "message_start": {
            // `input_tokens` counts only what was NOT cached — Anthropic bills
            // reads and writes separately and reports them separately. Summing
            // is not cosmetic: this number is how the loop knows the run's
            // context size (it feeds needsCompaction and the learned window
            // ceiling), and a cached token occupies the window exactly like a
            // fresh one. Report the unsummed figure and a well-cached run looks
            // a tenth its real size, so auto-compaction never fires and the run
            // dies on a context 400 it should have compacted its way past.
            const usage = event.message?.usage;
            freshInput = usage?.input_tokens ?? 0;
            cacheRead = usage?.cache_read_input_tokens ?? 0;
            cacheWritten = usage?.cache_creation_input_tokens ?? 0;
            logCacheUsage(freshInput + cacheRead + cacheWritten, cacheRead, cacheWritten);
            break;
          }
          case "message_delta": {
            // Carries stop_reason and cumulative usage. Z.ai's coding endpoint
            // opens at input 0 and reports the real input totals here instead
            // (measured by @providerkit/core, 2026-09-13). The counters are
            // cumulative, so a field left out keeps what message_start said.
            freshInput = event.usage?.input_tokens ?? freshInput;
            cacheRead = event.usage?.cache_read_input_tokens ?? cacheRead;
            cacheWritten = event.usage?.cache_creation_input_tokens ?? cacheWritten;
            if (event.delta?.stop_reason) {
              yield { type: "finish", reason: mapStopReason(event.delta.stop_reason) };
            }
            yield {
              type: "usage",
              input: freshInput + cacheRead + cacheWritten,
              output: event.usage?.output_tokens ?? 0,
              // The cache split of that input — reads and writes bill at their
              // own rates, so cost cannot be estimated from the sum alone.
              cacheRead: cacheRead,
              cacheWrite: cacheWritten,
            };
            break;
          }
          case "content_block_start": {
            if (event.content_block?.type === "tool_use") {
              toolCallBuffer = {
                id: event.content_block.id ?? "",
                // The model echoes prefixed names back in OAuth mode — the wire
                // is "custom_*", the loop only ever sees the unprefixed name.
                name: stripToolPrefix(event.content_block.name ?? ""),
                args: "",
              };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
              yield { type: "text", text: delta.text ?? "" };
            }
            if (delta?.type === "thinking_delta") {
              yield { type: "reasoning", text: delta.thinking ?? "" };
            }
            if (delta?.type === "input_json_delta" && toolCallBuffer) {
              toolCallBuffer.args += delta.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            if (toolCallBuffer) {
              yield {
                type: "tool_use",
                id: toolCallBuffer.id,
                name: toolCallBuffer.name,
                args: parseToolArgs(toolCallBuffer.args),
              };
              toolCallBuffer = null;
            }
            break;
          }
          case "message_stop": {
            yield { type: "done" };
            return;
          }
          case "error":
            throw streamFrameError(config, event.error);
        }
      }

      yield { type: "done" };
    },
  };
}

/** How this adapter drives one model's thinking. */
interface ClaudeThinking {
  /** Takes `thinking: {type: "adaptive"}`. Where it does not, the request
   *  carries no thinking field and no effort (see buildAnthropicBody). */
  adaptive: boolean;
  /** `max_tokens` for every request to it. */
  maxTokens: number;
}

/**
 * Every model without a row. Every Claude from 4.6 on takes adaptive, the ones
 * the app offers included (Fable 5.1, Opus 5.5, Sonnet 5.5). The other vendors
 * on this wire (Kimi, GLM, Qwen) get it too, as they always have; not every one
 * of them was measured with it. Thinking tokens count against
 * max_tokens, and thinking is always on here, so the cap does not depend on
 * effort: it must exceed the budget the provider assigns (coding-plan gateways
 * reject the request otherwise — seen: 32768) and still leave room for the
 * answer.
 */
const ADAPTIVE: ClaudeThinking = { adaptive: true, maxTokens: 65536 };

/**
 * Extended thinking only. Documented (Anthropic's per-model thinking table,
 * read 2026-09-30): Opus 4.5, Sonnet 4.5 and Haiku 4.5 answer
 * `{type: "adaptive"}` with a 400 ("adaptive thinking is not supported on this
 * model") and default to thinking off. Their output cap is "64K tokens" on
 * each model's page, which gives no exact integer, so this takes the smaller
 * reading: 65536 is over the cap if "64K" means 64,000.
 */
const EXTENDED_ONLY: ClaudeThinking = { adaptive: false, maxTokens: 64000 };

/**
 * The models that differ from ADAPTIVE, by id without its date (a dated
 * snapshot like claude-haiku-4-5-20251001 is its family). Keyed on the model
 * rather than the preset, because OpenCode routes these same ids through this
 * adapter. A new exception is a new row.
 *
 * Opus 4, Opus 4.1 and Sonnet 4 were extended-only too and have no row: all
 * three are retired (Anthropic's model deprecations page, read 2026-09-30), so
 * a request to them fails whatever it carries.
 */
const CLAUDE_THINKING: ReadonlyMap<string, ClaudeThinking> = new Map([
  ["claude-opus-4-5", EXTENDED_ONLY],
  ["claude-sonnet-4-5", EXTENDED_ONLY],
  ["claude-haiku-4-5", EXTENDED_ONLY],
]);

function claudeThinking(model: string): ClaudeThinking {
  return CLAUDE_THINKING.get(model.replace(/-\d{8}$/, "")) ?? ADAPTIVE;
}

/**
 * The effort levels this adapter sends `model`, read from the same table: all
 * of them where it takes adaptive thinking, none where it does not, because
 * buildAnthropicBody drops effort there. The pickers offer only these. A model
 * that takes adaptive thinking but only some levels needs a list in its row.
 */
export function claudeEffortLevels(model: string): readonly ReasoningEffort[] {
  return claudeThinking(model).adaptive ? REASONING_EFFORTS : [];
}

/** A `system` entry. Anthropic takes a bare string too, but only the block form carries a marker. */
interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** Request body for POST /v1/messages. Exported for tests. */
export function buildAnthropicBody(
  config: ResolvedProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
): Record<string, unknown> {
  // Anthropic splits system from conversation. OAuth traffic additionally
  // prepends the client-identity block and prefixes every tool name.
  const isOAuth = Boolean(config.auth);
  const systemMsg = messages.find((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  // A cache marker only pays when the same prefix comes back, and the agent
  // loop is the one caller that sends a second turn. It is also the only one
  // that declares tools — compact, memory extraction, title and skill distill
  // all pass none and answer in a single shot, so a marker on those would bill
  // a 1.25x write against a cache nothing will ever read.
  const cacheable = tools.length > 0;
  const modelThinking = claudeThinking(config.model);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: modelThinking.maxTokens,
    stream: true,
    // tool_results and an injected mid-run message both serialize as user
    // messages, and can land back to back — merge them, Anthropic rejects
    // consecutive same-role messages.
    messages: markRollingBreakpoint(
      mergeConsecutiveUsers(conversation.map((m) => toAnthropicMessage(m, isOAuth))),
      cacheable,
    ),
  };

  const system: SystemBlock[] = [
    ...(isOAuth ? [{ type: "text" as const, text: CLAUDE_IDENTITY }] : []),
    ...(systemMsg ? [{ type: "text" as const, text: systemMsg.content }] : []),
  ];
  if (system.length > 0) {
    // The first cache breakpoint, on the last system block. Anthropic builds
    // its cache prefix in the order tools → system → messages, so a marker here
    // takes the tool definitions above it along: one of the four allowed
    // breakpoints spent, the whole fixed prefix of the run cached.
    //
    // It IS fixed — buildToolDefs and buildSystemPrompt are called once at run
    // start and the array is never rebuilt (loop.ts), and the prompt carries no
    // clock, URL, or tab list (the date rides in the first user message). So it
    // is byte-identical on turn 1 and turn 50, which is the whole premise: a
    // write bills 1.25x and a read 0.1x, so it pays back after ~1.3 turns and
    // every turn after that is close to free.
    //
    // Sent to every anthropic-shape provider, coding-plan proxies included —
    // cache_control has been GA on this API for a year and array-form `system`
    // is its ordinary shape, so a proxy that refuses either is one that would
    // fail the compatibility it advertises. If one does, it surfaces as a
    // normal classified provider error in chat, not a silent wrong answer.
    if (cacheable) system[system.length - 1]!.cache_control = { type: "ephemeral" };
    body.system = system;
  }

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: isOAuth ? `${TOOL_PREFIX}${t.name}` : t.name,
      description: t.description,
      input_schema: t.params,
    }));
  }

  // The extended-only ids get neither field. No thinking field is their default
  // (off), so it is also their "none". Their one thinking mode,
  // `{type: "enabled", budget_tokens}`, is not sent at any level: in that mode
  // the last assistant turn must open with its thinking block (documented,
  // Anthropic's extended-thinking page, read 2026-09-27), and toAnthropicMessage
  // replays none, so a tool loop would 400 from its second request. Effort goes
  // too: Haiku and Sonnet 4.5 list no effort support, and Opus 4.5 has no "max".
  // So the picked level does nothing on these three.
  if (!modelThinking.adaptive) return body;

  // Everywhere else adaptive thinking is this shape's floor, not an opt-in.
  // Sending no thinking field at all — what an unpinned effort used to do — is
  // the one shape where "default" meant reasoning *off*: the OpenAI and
  // Responses shapes leave the model to its own default, which for a current
  // reasoning model is not off. Adaptive costs nothing on a step that doesn't
  // need it, since Claude decides per turn.
  //
  // "none" lands on that same floor, and only the other levels pin
  // output_config.effort, so "none" and "default" are one request here. An
  // explicit off exists but is not safe to send: Anthropic's docs say Claude
  // Fable 5 answers `{type: "disabled"}` with a 400, and that Opus 5, which
  // accepts it, writes tool calls into its text with thinking off on tool-heavy
  // work — which is all this agent does. The endpoints that need it say so on
  // the preset (`explicitNone`).
  const explicitNone =
    config.reasoningEffort === "none" &&
    PRESETS.find((p) => p.id === config.id)?.explicitNone === true;
  body.thinking = explicitNone ? { type: "disabled" } : { type: "adaptive" };
  if (config.reasoningEffort && config.reasoningEffort !== "none") {
    body.output_config = { effort: config.reasoningEffort };
  }

  return body;
}

interface AnthropicSSE {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: {
    output_tokens?: number;
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  /** The `error` event — a failure after the 200 went out; see streamFrameError. */
  error?: unknown;
}

/** Idempotent — the non-OAuth path streams unprefixed names and is untouched. */
function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function mapStopReason(reason: string): "stop" | "length" | "tool_use" | "unknown" {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_use";
  return "unknown";
}

/**
 * `data:image/jpeg;base64,…` → an Anthropic image block. Anthropic takes the
 * media type and payload as separate fields; it does not accept a data URL.
 * A malformed URL falls back to png rather than throwing mid-request.
 */
function toImageBlock(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: match?.[1] ?? "image/png",
      data: match?.[2] ?? "",
    },
  };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

function asBlocks(
  content: string | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * The second breakpoint, on the tail of the newest message, moved forward every
 * turn. The system marker caches the run's fixed prefix; this one caches the
 * conversation, which by turn ten is the larger half of the bill.
 *
 * It works because Anthropic looks back a little way from an explicit
 * breakpoint for a shorter prefix it already holds: last turn's marker sits a
 * handful of blocks behind this one, so the read hits there and only this
 * turn's new blocks bill fresh. A turn adds two messages, and even a five-call
 * batch adds around eleven blocks — inside that lookback.
 *
 * ponytail: one rolling marker, riding on that lookback rather than pinning
 * both ends itself. The ceiling is a turn fat enough to overshoot it — a batch
 * of ten-plus calls, which the batching prompt does make reachable on a long
 * form; that turn silently reads nothing and bills its whole prefix fresh.
 * Nothing breaks, and the cache telemetry is where it would show. The upgrade
 * is a second rolling marker left on the PREVIOUS turn's tail, which pins the
 * read target exactly instead of hoping it is in range — two of the four
 * breakpoints spent on the conversation, still inside the cap.
 *
 * Safe to mutate: every block here was built by toAnthropicMessage during this
 * call, so nothing is shared with the loop's own message array.
 */
function markRollingBreakpoint(messages: AnthropicMessage[], cacheable: boolean) {
  const last = messages[messages.length - 1];
  if (!cacheable || !last) return messages;
  const blocks = asBlocks(last.content);
  const tail = blocks[blocks.length - 1];
  if (!tail) return messages;
  tail.cache_control = { type: "ephemeral" };
  last.content = blocks;
  return messages;
}

/** See buildAnthropicBody for why the merge exists. */
function mergeConsecutiveUsers(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev?.role === "user" && msg.role === "user") {
      prev.content = [...asBlocks(prev.content), ...asBlocks(msg.content)];
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

export function toAnthropicMessage(msg: ChatMessage, isOAuth = false) {
  if (msg.role === "assistant" && msg.toolCalls) {
    return {
      role: "assistant" as const,
      content: [
        ...(msg.content ? [{ type: "text", text: msg.content }] : []),
        // Replayed tool_use names ride the same prefixed wire as the tools we
        // declared, so a resumed OAuth run re-prefixes them on the way out.
        ...msg.toolCalls.map((tc) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: isOAuth ? `${TOOL_PREFIX}${tc.name}` : tc.name,
          input: tc.args,
        })),
      ],
    };
  }
  if (msg.role === "tool_results") {
    // Anthropic: all results collapse into ONE user message of tool_result blocks.
    // Screenshots nest directly inside their own result — no trailing message needed.
    return {
      role: "user" as const,
      content: (msg.toolResults ?? []).map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.images?.length
          ? [{ type: "text" as const, text: r.content }, ...r.images.map(toImageBlock)]
          : r.content,
      })),
    };
  }
  if (msg.role === "user" && msg.images?.length) {
    return {
      role: "user" as const,
      content: [{ type: "text" as const, text: msg.content }, ...msg.images.map(toImageBlock)],
    };
  }
  return { role: msg.role as "user" | "assistant", content: msg.content };
}
