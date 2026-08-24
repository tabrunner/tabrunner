import type {
  ChatMessage,
  ChatProvider,
  Delta,
  ResolvedProviderConfig,
  ToolDef,
  ToolResult,
} from "./types";
import { ProviderError } from "./types";
import { apiUrl, logCacheUsage, parseToolArgs, streamSse } from "./http";

/**
 * Responses-shape adapter — the only consumer is the ChatGPT subscription
 * provider (chatgpt.com/backend-api/codex), which exposes NO chat-completions
 * surface, so this speaks the Responses wire format at `POST {base}/responses`.
 *
 * Auth is a subscription access token (swapped in by ensureProviderCredential)
 * plus the account id the backend requires as `ChatGPT-Account-Id`.
 *
 * Reasoning: the ChatGPT backend streams `reasoning_summary_text` and
 * `reasoning_text` live, but REQUIRES reasoning to be blanked when replayed —
 * so the outgoing input carries no reasoning items, ever (the loop still
 * commits reasoning locally for the panel; it just never goes back upstream).
 */
export function createResponsesProvider(config: ResolvedProviderConfig): ChatProvider {
  return {
    async *stream(messages, tools, signal): AsyncIterable<Delta> {
      const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
      // The account id is REQUIRED by the backend; a missing one surfaces as a
      // clean 401 the user can recover from by re-signing-in.
      if (config.auth?.chatgptAccountId) {
        headers["ChatGPT-Account-Id"] = config.auth.chatgptAccountId;
      }

      // Tool calls stream as item skeletons + argument deltas; key by the
      // response item id so parallel calls never cross wires.
      const pending = new Map<string, PendingCall>();
      let sawToolUse = false;

      const flushPending = (): Delta[] => {
        const out: Delta[] = [];
        for (const call of pending.values()) {
          if (!call.callId) continue;
          sawToolUse = true;
          out.push({
            type: "tool_use",
            id: call.callId,
            name: call.name,
            args: parseToolArgs(call.args),
          });
        }
        pending.clear();
        return out;
      };

      const stream = streamSse({
        url: apiUrl(config.baseUrl, "/responses"),
        headers,
        body: JSON.stringify(buildResponsesBody(config, messages, tools)),
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
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = str(frame.type);

        switch (type) {
          case "response.output_text.delta":
            if (typeof frame.delta === "string") {
              yield { type: "text", text: frame.delta };
            }
            break;

          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            if (typeof frame.delta === "string") {
              yield { type: "reasoning", text: frame.delta };
            }
            break;

          case "response.output_item.added": {
            const item = isRec(frame.item) ? frame.item : undefined;
            if (!item || item.type !== "function_call") break;
            sawToolUse = true;
            const itemId = str(item.id);
            if (itemId) {
              pending.set(itemId, {
                callId: str(item.call_id) ?? "",
                name: str(item.name) ?? "",
                args: typeof item.arguments === "string" ? item.arguments : "",
              });
            }
            break;
          }

          case "response.function_call_arguments.delta": {
            const itemId = str(frame.item_id);
            const call = itemId ? pending.get(itemId) : undefined;
            if (call && typeof frame.delta === "string" && frame.delta.length > 0) {
              call.args += frame.delta;
            }
            break;
          }

          case "response.output_item.done": {
            const item = isRec(frame.item) ? frame.item : undefined;
            if (!item || item.type !== "function_call") break;
            sawToolUse = true;
            const itemId = str(item.id);
            const accumulated = itemId ? pending.get(itemId) : undefined;
            if (itemId) pending.delete(itemId);
            const callId = str(item.call_id) ?? accumulated?.callId ?? "";
            if (!callId) break;
            // The done event carries an authoritative arguments snapshot; deltas
            // are the fallback when that snapshot is empty.
            const candidate = typeof item.arguments === "string" ? item.arguments : "";
            const streamed = accumulated?.args ?? "";
            const args = candidate.length > 0 || streamed.length === 0 ? candidate : streamed;
            yield {
              type: "tool_use",
              id: callId,
              name: str(item.name) ?? accumulated?.name ?? "",
              args: parseToolArgs(args),
            };
            break;
          }

          case "response.completed": {
            // The terminal frame may arrive before a pending call's done event —
            // flush it so the loop still runs the tool it decided to call.
            for (const d of flushPending()) yield d;
            const usage = isRec(frame.response) ? frame.response.usage : undefined;
            if (isRec(usage)) yield usageDelta(usage);
            yield { type: "finish", reason: sawToolUse ? "tool_use" : "stop" };
            yield { type: "done" };
            return;
          }

          case "response.incomplete": {
            for (const d of flushPending()) yield d;
            const response = isRec(frame.response) ? frame.response : undefined;
            const details = isRec(response?.incomplete_details)
              ? response.incomplete_details
              : undefined;
            const reason = details?.reason === "max_output_tokens" ? "length" : "unknown";
            const usage = response?.usage;
            if (isRec(usage)) yield usageDelta(usage);
            yield { type: "finish", reason };
            yield { type: "done" };
            return;
          }

          case "response.failed": {
            const error = isRec(frame.response) ? frame.response.error : undefined;
            throw streamError(
              str(isRec(error) ? error.message : undefined) ?? "upstream stream failed",
            );
          }

          case "error":
          case "response.error": {
            const error = isRec(frame.error) ? frame.error : frame;
            throw streamError(
              str(isRec(error) ? error.message : undefined) ??
                str(frame.message) ??
                "upstream stream error",
            );
          }
        }
      }

      // The stream closed without a terminal event — the loop still gets a
      // clean end; a missing completed means no usage, but the text streamed.
      for (const d of flushPending()) yield d;
      yield { type: "done" };
    },
  };
}

/** The body for POST /responses. Exported for tests. */
export function buildResponsesBody(
  config: ResolvedProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
): Record<string, unknown> {
  // The Responses API has no system role — the first system message becomes
  // `instructions`; everything else is the input item list.
  const systemMsg = messages.find((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model: config.model,
    input: conversation.flatMap(toResponsesInput),
    stream: true,
    store: false,
  };
  if (systemMsg) body.instructions = systemMsg.content;
  if (tools.length > 0) body.tools = tools.map(toResponsesTool);

  // The ChatGPT backend has no off switch for reasoning — `none` omits the
  // knob entirely; the rest map to the standard Responses effort config.
  if (config.reasoningEffort && config.reasoningEffort !== "none") {
    body.reasoning = { effort: config.reasoningEffort };
  }

  return body;
}

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | ResponsesContentPart[];
    };

/** Map one stored message to its Responses input item(s). Exported for tests. */
export function toResponsesInput(msg: ChatMessage): ResponsesInputItem[] {
  if (msg.role === "tool_results") {
    const results = msg.toolResults ?? [];
    return results.map((r): ResponsesInputItem => {
      const output = toolOutput(r);
      return { type: "function_call_output", call_id: r.id, output };
    });
  }
  if (msg.role === "user") {
    const content: ResponsesContentPart[] = [{ type: "input_text", text: msg.content }];
    for (const url of msg.images ?? []) content.push({ type: "input_image", image_url: url });
    return [{ type: "message", role: "user", content }];
  }
  if (msg.role === "assistant") {
    const out: ResponsesInputItem[] = [];
    // Reasoning is deliberately NOT echoed — the ChatGPT backend requires it
    // blanked, and the output_text part is all an assistant turn replays.
    if (msg.content) {
      out.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: msg.content }],
      });
    }
    for (const tc of msg.toolCalls ?? []) {
      out.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      });
    }
    return out;
  }
  // system was split out by buildResponsesBody — nothing left to send.
  return [];
}

/** Tool output is a string unless the result carried images — then the codex-rs content-array form. */
function toolOutput(result: ToolResult): string | ResponsesContentPart[] {
  const images = result.images ?? [];
  if (images.length === 0) return result.content ?? "";
  const parts: ResponsesContentPart[] = [];
  if (result.content) parts.push({ type: "input_text", text: result.content });
  for (const url of images) parts.push({ type: "input_image", image_url: url });
  return parts;
}

function toResponsesTool(tool: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.params,
  };
}

interface PendingCall {
  callId: string;
  name: string;
  args: string;
}

/** A mid-stream backend failure — the raw HTTP layer already classified HTTP errors. */
function streamError(message: string): ProviderError {
  return new ProviderError(message, 0);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * `response.completed` and `response.incomplete` both close a stream and both
 * carry usage in the same shape — a turn that ran out of output tokens still
 * billed for its input.
 *
 * `input_tokens` already includes whatever was served from cache here, so it
 * needs no reconciling; `cached_tokens` is the subset, and the only signal that
 * this shape's automatic prefix caching is working.
 */
function usageDelta(usage: Record<string, unknown>): Delta {
  const input = num(usage.input_tokens) ?? 0;
  const details = isRec(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const cached = num(details?.cached_tokens) ?? 0;
  logCacheUsage(input, cached);
  return {
    type: "usage",
    input,
    output: num(usage.output_tokens) ?? 0,
    cacheRead: cached,
    // Gateways that price their own calls ride the figure through verbatim.
    ...(num(usage.cost) !== undefined ? { cost: num(usage.cost) } : {}),
  };
}
