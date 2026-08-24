import type { ErrorKind } from "./error-classify";

/** Provider shape — determines wire format for API calls. */
export type ProviderShape = "openai" | "anthropic" | "responses";

/**
 * Reasoning effort — how hard the model thinks before acting.
 * Absent = provider default (never sent). Passed through verbatim on
 * OpenAI-shape (`reasoning_effort`); mapped to adaptive thinking +
 * `output_config.effort` on Anthropic-shape. Support varies per model —
 * an unsupported level comes back as a clean provider 400, surfaced in chat.
 *
 * Ordered least → most; the type derives from the array so a runtime guard
 * and the union can never drift apart.
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** The one place the effort union meets raw input (the pickers, slash commands). */
export function isEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

/** i18n keys for the effort levels — a Record keyed by the union, so a new
 *  level is a compile error here instead of a silently missing option. */
export const EFFORT_LABEL_KEYS = {
  none: "modelPicker.effort.none",
  low: "modelPicker.effort.low",
  medium: "modelPicker.effort.medium",
  high: "modelPicker.effort.high",
  max: "modelPicker.effort.max",
} as const satisfies Record<ReasoningEffort, string>;

/**
 * Tokens from a provider's OAuth sign-in, in place of a pasted key. Both
 * tokens rotate on every refresh, so a refresh always persists both.
 */
export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  /**
   * Epoch ms, already skewed early by REFRESH_SKEW_MS — treat it as "refresh
   * at or after this", not as the server's true expiry.
   */
  expiresAt: number;
  /** Display only, decoded from the token — names the signed-in account in the UI. */
  account?: string;
  /**
   * The ChatGPT account the token belongs to, extracted from the JWT at sign-in.
   * The Codex backend requires it as the `ChatGPT-Account-Id` header on every
   * request; re-extracted on refresh (and kept from the old credential when the
   * new token omits it), so the header can never go stale.
   */
  chatgptAccountId?: string;
}

/** Why a sign-in ended without a credential — each wording is a different fix. */
export type SignInFailure = "expired" | "denied" | "cancelled";

/** Thrown by the per-vendor sign-in flows (device code, callback capture) so the UI can word each ending. */
export class SignInError extends Error {
  constructor(public readonly reason: SignInFailure) {
    super(reason);
    this.name = "SignInError";
  }
}

/** A configured provider instance (stored in chrome.storage). */
export interface ProviderConfig {
  id: string;
  name: string;
  shape: ProviderShape;
  baseUrl: string;
  /** Empty when the provider signs in instead — `auth` carries the credential. */
  apiKey: string;
  /** Present only for OAuth providers; absent means the apiKey is the credential. */
  auth?: OAuthCredential;
  /** Absent = auto — resolveProviderModel picks the newest model the endpoint serves. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  createdAt: number;
}

/**
 * One conversation's engine pick — the three picker choices, stored verbatim.
 * The PICK, never the resolution: an absent `model` means auto, so a pinned
 * conversation still follows the endpoint's newest model, and an absent
 * `effort` means the provider's own default. What a run actually resolved to
 * is stamped per run on `RunSummary.model` instead.
 */
export interface ConversationEngine {
  providerId: string;
  model?: string;
  effort?: ReasoningEffort;
}

/**
 * A config whose model has been resolved to a concrete id — what adapters
 * accept. `apiKey` here is the EFFECTIVE bearer: for OAuth providers the
 * credential seam swaps in a fresh access token, so adapters never learn
 * which kind of credential they are holding.
 */
export interface ResolvedProviderConfig extends ProviderConfig {
  model: string;
  /**
   * Whether the resolved model can receive images. Absent = capable: the flag
   * is only ever false for a known text-only family (DeepSeek preset). No
   * provider ships per-model vision in its listing, so the preset is the source.
   */
  supportsImages?: boolean;
}

/** One entry from a provider's model listing. `created` is epoch ms when the endpoint reports it. */
export interface ModelInfo {
  id: string;
  /** Human label when the endpoint ships one — Anthropic's `display_name`
   *  ("Claude Sonnet 4.5"), OpenRouter's `name`. Absent on plain OpenAI. */
  name?: string;
  created?: number;
  /** Context window in tokens, when the endpoint volunteers it (OpenRouter,
   *  LM Studio, Ollama do; Anthropic and OpenAI don't). Feeds the compaction
   *  threshold — see providers/context-window.ts for the rest of the ladder. */
  contextLength?: number;
}

/** Chat message in provider-agnostic format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool_results";
  content: string;
  /**
   * The model's reasoning on an assistant turn. Thinking-mode providers demand
   * it echoed verbatim (DeepSeek 400s on tool-call turns without it), so the
   * loop commits it even though the panel treats reasoning as display-only.
   * OpenAI-shape serializes it as `reasoning_content`; Anthropic-shape drops
   * it — its thinking blocks carry signatures we never capture. Loop-local:
   * transcripts persist the panel's own rows, never the wire conversation.
   */
  reasoning?: string;
  toolCalls?: ToolCall[];
  /** Results of tool calls from the previous assistant turn. Adapters serialize
   *  differently: OpenAI expands to N role:tool messages, Anthropic collapses
   *  to one user message with N tool_result blocks. */
  toolResults?: ToolResult[];
  /** Images attached to a user message, as `data:` URLs. */
  images?: string[];
}

export interface ToolResult {
  id: string;
  content: string;
  /**
   * Images produced by the tool (screenshots), as `data:` URLs. Anthropic nests
   * them inside the tool_result block; OpenAI-shape tool messages are text-only,
   * so that adapter trails a user message carrying them instead.
   */
  images?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Tool definition in provider-agnostic format. */
export interface ToolDef {
  name: string;
  description: string;
  params: JSONSchema;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface JSONSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  /** Element schema for `type: "array"` — both wire formats pass it through verbatim. */
  items?: { type: string };
  /** Nested fields for `type: "object"` — a rule with several parts (a
   *  recurrence) reads far better as one argument than as five flat ones. */
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/**
 * One call's token counts, as the adapters report them. `input` is the FULL
 * input — every token the request put in the window, cached or not — because
 * that is what context size means everywhere else (the gauge, compaction).
 * `cacheRead`/`cacheWrite` are the cached slices OF that input, kept because
 * they bill at different rates and cost cannot be computed without them.
 * `cost` rides through only from gateways that price the call themselves
 * (OpenRouter-style `usage.cost`); absent everywhere else.
 */
export interface UsageTick {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** What the gateway says this call cost, USD — used verbatim when present. */
  cost?: number;
}

/** Streaming delta from the provider. */
export type Delta =
  | { type: "text"; text: string }
  /** Model reasoning (Anthropic thinking blocks, OpenAI-shape reasoning_content) — the panel
   *  displays it live; the loop also commits it on the assistant turn for providers that
   *  demand it echoed (see ChatMessage.reasoning). */
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; args: Record<string, unknown> }
  | ({ type: "usage" } & UsageTick)
  | { type: "finish"; reason: "stop" | "length" | "tool_use" | "unknown" }
  | { type: "done" };

/** Provider error with HTTP status so the loop can classify retryability. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** What the body says is actually wrong — overrides the status for retry decisions. */
    public readonly kind?: ErrorKind,
    /** Server-requested wait (`retry-after`) — a long one means a usage window, not a blip. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Permanent failures — no amount of backoff fixes an empty balance or a missing model. */
const NON_RETRYABLE_KINDS: readonly ErrorKind[] = ["entitlement", "quota", "model"];

/**
 * Longest server-requested wait worth holding a run for. Beyond it the limit
 * is a usage window (subscription 5h/weekly resets run hours to days), so the
 * run fails fast with the reset time instead of retrying into the same wall.
 */
const MAX_RETRY_WAIT_MS = 60_000;

/**
 * 429 and 5xx are transient — retry in place. Other 4xx request errors are not.
 * A classified permanent failure never retries even when its status looks
 * transient: OpenAI files "insufficient_quota" under 429. A 429 whose
 * retry-after exceeds MAX_RETRY_WAIT_MS isn't transient either.
 *
 * Auth is the one kind a single response can't settle. Coding-plan gateways —
 * Kimi most visibly — reject roughly one request in fifty with
 * `authentication_error` on a credential that works on the next call, and that
 * body is indistinguishable from a real rejection. So the retry IS the test: a
 * key that is genuinely invalid loses all of the loop's attempts and still
 * reports itself with its "check the key" fix, while a gateway blip clears on
 * the second. Only the streaming endpoint gets here — a dead OAuth refresh
 * throws from start-run, and a mistyped key fails model listing in Settings,
 * both well outside the loop.
 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ProviderError) {
    if (e.kind && NON_RETRYABLE_KINDS.includes(e.kind)) return false;
    if (e.retryAfterMs !== undefined && e.retryAfterMs > MAX_RETRY_WAIT_MS) return false;
    return e.kind === "auth" || e.status === 429 || e.status >= 500;
  }
  // Network-level failures (TypeError from fetch) have no status — retryable
  return e instanceof TypeError;
}

/** Provider interface — both adapters implement this. */
export interface ChatProvider {
  stream(messages: ChatMessage[], tools: ToolDef[], signal: AbortSignal): AsyncIterable<Delta>;
}
