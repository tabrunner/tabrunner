import type { EffortDialect } from "@providerkit/core";
import type { ProviderShape } from "./types";
import { copilotHeaders } from "@providerkit/core/auth";
import { appName } from "./oauth";
import { i18n } from "@/i18n";

/** Preset provider — just data, no code. Adding a provider starts here. */
export interface ProviderPreset {
  id: string;
  name: string;
  /** Unavailable for chat selection or requests; saved credentials remain intact. */
  disabled?: true;
  shape: ProviderShape;
  baseUrl: string;
  models: string[];
  apiKeyUrl?: string;
  /** Brand accent for the icon tile */
  color: string;
  /** Key into the icon set in ui/ProviderIcon */
  icon: IconKey;
  /**
   * Whether this family's models can receive images. Absent = capable. Only
   * DeepSeek is text-only. No provider ships per-model vision in its listing,
   * so the family flag is the single source of truth.
   */
  supportsImages?: boolean;
  /**
   * Present when the provider is signed into instead of keyed. The form swaps
   * the key field for a sign-in button and the list offers signing out.
   */
  auth?: "oauth";
  /**
   * Set on a KEYED row that can also be signed into. The form then offers both
   * and the user picks. Distinct from `auth` on purpose: `auth` says the provider
   * is paid for a different way and so earns its own row, while this says the very
   * same account can be reached without a trip to the console.
   *
   * - `"key"`: the sign-in ends in an ordinary API key on the same account,
   *   billed from the same credits (OpenRouter).
   * - `"account"`: the sign-in is the account itself and its token is the
   *   credential, renewed like a subscription's (OpenCode Zen).
   */
  signIn?: "key" | "account";
  /**
   * The endpoint serves a standing shelf of free models, which is why the row
   * leads the picker: it is the shortest path to a first working run. The shelf
   * sits behind a gate that only OpenCode's own client passes — see zen.ts.
   */
  free?: true;
  /**
   * The backend has no model-list route, so `models` is the list. Cloud Code
   * Assist behind Antigravity is one; ChatGPT instead lists its account catalog.
   */
  staticModels?: true;
  /**
   * Gemini-shape only: the request path, when the backend routes by something
   * other than the model name. Antigravity's `/v1internal:…` takes the model in
   * the body's envelope instead.
   */
  path?: string;
  /**
   * Set on both rows of a product sold two ways. `name` stays the bare product
   * ("Claude", "Anthropic"); `providerDisplayName` appends which way, so a user
   * holding both a plan and a key always knows which quota a run spends. A
   * product with a single row needs no qualifier — and neither does a surface
   * that already says it, like the picker's own section headers.
   */
  paired?: true;
  /**
   * Extra request headers for the run, built per request. GitHub Copilot
   * wants an editor fingerprint, and it bills on `turn` — "user" for a turn
   * the person started, "agent" for the run's own follow-ups after tool
   * results. OpenRouter wants app attribution for its rankings
   * (`HTTP-Referer` + `X-Title`), which never varies by turn. A builder
   * rather than a constant because Copilot's half is something the preset
   * cannot know by itself.
   */
  headers?: (turn: "user" | "agent") => Record<string, string>;
  /**
   * Responses-shape only: this endpoint takes a tool result's images inside
   * the `function_call_output` item, the way codex-rs does. The published
   * Responses shape says that field is a string, so everyone else gets the
   * images in a trailing user message instead. The ChatGPT backend is the only
   * one — see responses.ts.
   */
  inlineToolImages?: true;
  /**
   * OpenAI-shape only: this endpoint spells "think this hard" its own way, so
   * the effort goes out through @providerkit/core's `effortParams` instead of
   * as a verbatim `reasoning_effort`. OpenRouter wants its own `reasoning`
   * object, and says "none" per model: "low" for GLM 5.3 Flash and "minimal"
   * for gpt-5-mini (every explicit off is a 400 on both), an explicit "none"
   * for MiMo v2.6 Flash, and nothing for a model not measured. DeepSeek thinks
   * unless told `thinking: {type: "disabled"}`. The per-model rule lives in the
   * package, beside the measurements behind it (OpenRouter, 2026-09-26 and
   * 2026-09-27, recorded in its `OPENROUTER_NONE` doc, 0.12.3). OpenCode's
   * gateways use core's `opencode-go` table: GLM takes only high and max, and
   * DeepSeek and MiniMax answer an explicit "none" with a 400, so they get "low".
   */
  effortDialect?: Extract<EffortDialect, "openrouter" | "deepseek" | "opencode-go">;
  /**
   * Anthropic-shape only: "none" is sent as `thinking: {type: "disabled"}`
   * instead of the adaptive floor. Z.ai's coding endpoint needs it. Measured by
   * @providerkit/core on 2026-09-13, live against api.z.ai/api/anthropic on
   * glm-5.3-flash (recorded in its zai.ts): a missing thinking field gave a
   * thinking block, `disabled` gave none. The adaptive floor this endpoint got
   * before was not part of that measurement. Never on Anthropic itself: its
   * docs say Claude Fable 5 answers an explicit disabled with a 400.
   */
  explicitNone?: true;
  /**
   * The header that names the conversation on every chat turn, for the
   * endpoints that key something on it. Its value is the conversation id.
   *
   * OpenCode's gateways read `x-opencode-session`, the same header pi's opencode
   * providers send. Without it the free tier answers `FreeTierError`. On Go the
   * value is the conversation id; on Zen (`free`) it is that id forged into the
   * `ses_` shape, sent with the rest of the headers OpenCode's client sends — see
   * zen.ts. The `User-Agent` cannot ride on fetch (Chromium ignores it), so
   * origin.ts stamps it on the request.
   *
   * The ChatGPT backend reads `session-id`, and keys its prompt cache on it
   * (with `responsesCacheKey`). @providerkit/core's chatgpt preset sends the
   * same pair (0.16.0).
   */
  sessionHeader?: "x-opencode-session" | "session-id";
  /**
   * Responses-shape only: the conversation id also goes out as
   * `prompt_cache_key`. The ChatGPT backend shards its prompt cache by it, so
   * without it a conversation's turns land on different shards and the prefix
   * they re-send misses. Only ChatGPT: OpenCode's Responses shelf was never
   * checked with it.
   */
  responsesCacheKey?: true;
  /**
   * Models on this endpoint that don't speak the preset's own shape. OpenCode's
   * gateway serves each model family on its own wire endpoint — GPT/Grok/
   * Muse-Spark on Responses, Claude/Qwen on Anthropic Messages, the rest
   * (DeepSeek/GLM/Kimi/MiniMax/the free shelf) on chat completions — and a
   * model called on the wrong endpoint answers 500, not a helpful 404. The
   * tables come from OpenCode's own Zen/Go docs; anything unlisted stays on
   * the preset's shape, which is today's behaviour, never a regression.
   */
  modelRoutes?: {
    responses?: string[];
    anthropic?: string[];
    /** Google's own wire, at the gateway's `…/v1/models/<id>:streamGenerateContent`. */
    gemini?: string[];
  };
}

export type IconKey =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "kimi"
  | "zai"
  | "qwen"
  | "gemini"
  | "groq"
  | "openrouter"
  | "opencode"
  | "ollama"
  | "mistral"
  | "xai"
  | "github"
  | "meta";

/**
 * Built-in presets. Users can also add custom OpenAI-compatible endpoints.
 *
 * Order is the picker's order, and the first entry is what the add form opens
 * on. Antigravity leads with its free quota and an account-risk warning, then
 * Zen's free shelf, subscription sign-ins and keyed providers. Each section
 * stays contiguous so the picker can group it without sorting.
 *
 * A subscription row is named for the product people actually buy (Claude,
 * ChatGPT) and a keyed row for the company whose console issues the key
 * (Anthropic, OpenAI) — the vendors draw that line themselves, so following it
 * means each row wears the name its own audience already knows. Where a vendor
 * runs one brand for both (Kimi), both rows keep it and `paired` tells them
 * apart.
 *
 * The "coding plan" endpoints (Kimi, Z.ai, QwenCloud) speak the Anthropic wire
 * format at custom base URLs — that's why they're anthropic-shaped presets,
 * not custom configs.
 */
export const PRESETS: ProviderPreset[] = [
  {
    // Google sign-in supplies the project id used by Cloud Code Assist.
    // The setup form explains the free quota and third-party account risks.
    id: "antigravity",
    name: "Google Antigravity",
    shape: "gemini",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    path: "/v1internal:streamGenerateContent?alt=sse",
    models: [
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
    ],
    auth: "oauth",
    staticModels: true,
    color: "#1E88E5",
    icon: "gemini",
  },
  {
    // Zen is a gateway with both free models and paid account access.
    // Keep its request compatibility separate from the setup display group.
    //
    // Two ways in: sign in with the OpenCode account (the Console's device flow,
    // the first thing the form shows) or paste a key (`apiKeyUrl`). Free means
    // $0 per token, NOT no card: an OpenCode account wants billing details
    // before it issues a key at all.
    //
    // `models` is the cold start, in Zen's own listing order (free shelf first,
    // which is also what "auto" resolves to once the live listing lands). The
    // shelf rotates, and a retired free id answers 500, so the live listing is
    // the authority. Checked against it 2026-10-21; the free ids below each
    // answered a streamed call that offered a tool.
    id: "opencode",
    name: "OpenCode Zen",
    // Keep the integration for a future repair; current free requests are rejected.
    disabled: true,
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    models: [
      "big-pickle",
      "mimo-v2.6-flash-free",
      "deepseek-v4.1-flash-free",
      "glm-5.3-flash-free",
      "minimax-m3.1-flash-free",
      "glm-5.3",
      "claude-sonnet-5-5",
      "gpt-5.5",
    ],
    apiKeyUrl: "https://opencode.ai/auth",
    signIn: "account",
    free: true,
    sessionHeader: "x-opencode-session",
    effortDialect: "opencode-go",
    // Zen serves each model family on its own wire: Claude and Qwen on Messages,
    // GPT/Grok/Muse on Responses, Gemini on Google's own, the rest (DeepSeek,
    // GLM, Kimi, MiniMax, the whole free shelf) on chat completions. A model
    // called on the wrong wire answers 500, not a helpful 404. These lists are
    // the live /models of 2026-10-21 sorted by family; a model missing from
    // them stays on chat completions until it is added.
    modelRoutes: {
      responses: [
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-luna",
        "gpt-5.6-terra",
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "grok-4.7",
        "grok-build-0.1",
        "muse-wonder-1.0",
      ],
      anthropic: [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-opus-5-5-backup",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "qwen3.8-flash",
        "qwen3.6-plus",
      ],
      gemini: ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro"],
    },
    color: "#171717",
    icon: "opencode",
  },
  {
    // The same API as `anthropic`, reached with a Claude subscription (Pro/Max)
    // sign-in instead of a key. One row per way to pay — a user with both a key
    // and a plan always knows which quota a run spends.
    id: "claude",
    name: "Claude",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    auth: "oauth",
    paired: true,
    color: "#D97757",
    icon: "anthropic",
  },
  {
    // Codex lists the signed-in account's models. Never guess an Auto model
    // from the public API catalog or a static subscription shelf.
    id: "chatgpt",
    name: "ChatGPT",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    models: [],
    auth: "oauth",
    paired: true,
    inlineToolImages: true,
    sessionHeader: "session-id",
    responsesCacheKey: true,
    color: "#10A37F",
    icon: "openai",
  },
  {
    // The same coding endpoint as `kimi`, reached with a subscription sign-in
    // instead of a key. Kimi bills the two separately, so they stay separate
    // rows — a user with both always knows which quota a run spends.
    id: "kimi-plan",
    name: "Kimi Coding",
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    models: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
    auth: "oauth",
    paired: true,
    color: "#0F172A",
    icon: "kimi",
  },
  {
    // The same endpoint as `xai`, reached with a SuperGrok or X Premium
    // sign-in instead of a key. Named for what people actually buy: the
    // subscription is sold as Grok, the key console is sold as xAI.
    id: "xai-plan",
    name: "Grok",
    shape: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4.6", "grok-4.5"],
    auth: "oauth",
    paired: true,
    color: "#000000",
    icon: "xai",
  },
  {
    // Muse, reached with the Meta subscription. Two hops: an identity token
    // from the device flow, then a Model API key minted from it — see
    // the Meta flow in @providerkit/core/auth. Responses shape, but the published one, not codex's.
    id: "meta",
    name: "Meta Muse",
    shape: "responses",
    baseUrl: "https://api.meta.ai/v1",
    models: ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2"],
    auth: "oauth",
    color: "#0064E0",
    icon: "meta",
  },
  {
    // Copilot, reached with the GitHub subscription. Two hops to a credential
    // and a base URL the account's own plan names — see the Copilot flow in @providerkit/core/auth. The
    // model list is live (`GET /models`), filtered to what the account can
    // actually serve (see models.ts) — so these are only the cold start, and
    // every one must be servable over chat completions: the GPT models that
    // only answer on the Responses API are reachable by free text, never
    // advertised here.
    id: "github-copilot",
    name: "GitHub Copilot",
    shape: "openai",
    baseUrl: "https://api.individual.githubcopilot.com",
    models: ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex", "claude-sonnet-5", "claude-opus-4.8"],
    auth: "oauth",
    headers: (turn) => copilotHeaders(appName(), turn),
    color: "#24292F",
    icon: "github",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    paired: true,
    color: "#D97757",
    icon: "anthropic",
  },
  {
    id: "openai",
    name: "OpenAI",
    shape: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4o"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
    paired: true,
    color: "#000000",
    icon: "openai",
  },
  {
    id: "kimi",
    // Moonshot AI issues the key, but the endpoint is Kimi's coding plan, not
    // Moonshot's general API — naming the company here would advertise the
    // wrong one. The key console is a click away on `apiKeyUrl`.
    name: "Kimi Coding",
    shape: "anthropic",
    baseUrl: "https://api.kimi.ai/coding",
    models: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
    apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
    paired: true,
    color: "#0F172A",
    icon: "kimi",
  },
  {
    id: "zai",
    name: "Z.ai Coding",
    shape: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
    // GLM-5.3 is the current flagship, 5.3-flash its cheaper native-multimodal
    // sibling (both fully available on the coding plan); 5.2 stays as fallback.
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.2"],
    apiKeyUrl: "https://z.ai/manage-apikey/apikey-list",
    explicitNone: true,
    color: "#3B5BFD",
    icon: "zai",
  },
  {
    id: "qwen",
    name: "Qwen",
    shape: "anthropic",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    models: ["qwen3.8-max", "qwen3.6-flash"],
    apiKeyUrl: "https://bailian.console.aliyun.com/",
    color: "#615CED",
    icon: "qwen",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shape: "openai",
    baseUrl: "https://api.deepseek.com",
    // The chat/reasoner aliases were retired 2026-07-24 (they 400 now; both
    // resolved to v4-flash). Thinking is a request-level mode on the flash
    // model, not an id of its own.
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    color: "#4D6BFE",
    icon: "deepseek",
    // Text-only API — a screenshot (image_url) in the body is a hard 400.
    supportsImages: false,
    effortDialect: "deepseek",
  },
  {
    id: "gemini",
    name: "Gemini",
    // Native Generative Language REST, NOT the OpenAI-compatible shim: only
    // the native endpoint carries thought signatures, and dropping them
    // spins the run on textless, call-less turns (see gemini.ts). pi and the
    // opencode CLI both go native for the same reason.
    shape: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    // The 2.x shelf is being retired (2.5-flash-lite already 404s, naming
    // 3.5-flash-lite as its replacement) — the fallback leads with the 3.x
    // ids Google and OpenCode's own docs both name now.
    models: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
    apiKeyUrl: "https://aistudio.google.com/apikey",
    color: "#1E88E5",
    icon: "gemini",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shape: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    // Signing in mints a key on the same account, billed from the same
    // credits — a shortcut past the console, not a second way to pay, so it
    // stays one row. See the OpenRouter flow in @providerkit/core/auth.
    signIn: "key",
    effortDialect: "openrouter",
    // App attribution for OpenRouter's rankings — public, not secret. Rides
    // every chat turn and the model listing alike.
    headers: () => ({
      "HTTP-Referer": "https://tabrunner.app",
      "X-Title": "TabRunner",
    }),
    color: "#334155",
    icon: "openrouter",
  },
  {
    // The same key as `opencode`, on OpenCode's cheaper catalog — a different
    // endpoint and a different shelf, not a different way to pay, so it keeps
    // its own row rather than a `paired` qualifier. No free tier here; the ids
    // are OpenCode's own Go docs. `ox-alpha` was GLM-5.3-flash's anonymous
    // test name and is retired — it 404s, so it is not listed.
    id: "opencode-go",
    name: "OpenCode Go",
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
    models: [
      "mimo-v2.6-flash",
      "muse-spark-1.3-contributor",
      "glm-5.3",
      "kimi-k2.6",
      "qwen3.8-max",
      "mimo-v2.5",
    ],
    apiKeyUrl: "https://opencode.ai/auth",
    sessionHeader: "x-opencode-session",
    // Per OpenCode's Go docs, with pi's correction: pi reroutes minimax-m2.7
    // and qwen3.5/3.6-plus to chat completions (their Go endpoints want Bearer
    // on /chat/completions despite what models.dev claims), so only the ids
    // below ride /messages and /responses.
    modelRoutes: {
      responses: [
        "grok-4.7",
        "grok-4.6",
        "gpt-6-luna",
        "gpt-5.6-luna",
        "muse-spark-1.3-contributor",
        "muse-spark-1.2-contributor",
      ],
      anthropic: ["minimax-m3", "minimax-m2.5", "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus"],
    },
    color: "#404040",
    icon: "opencode",
  },
  {
    id: "groq",
    name: "Groq",
    shape: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile"],
    apiKeyUrl: "https://console.groq.com/keys",
    color: "#F55036",
    icon: "groq",
  },
  {
    id: "mistral",
    name: "Mistral",
    shape: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest"],
    apiKeyUrl: "https://console.mistral.ai/api-keys/",
    color: "#FF7000",
    icon: "mistral",
  },
  {
    id: "xai",
    name: "xAI",
    shape: "openai",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4.6", "grok-4.5"],
    apiKeyUrl: "https://console.x.ai/",
    paired: true,
    color: "#000000",
    icon: "xai",
  },
  {
    id: "ollama",
    name: "Ollama",
    shape: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    color: "#000000",
    icon: "ollama",
  },
];

// Stable sorting keeps disabled options last without changing enabled sections.
PRESETS.sort((a, b) => Number(a.disabled ?? false) - Number(b.disabled ?? false));

export type PresetSection = "free" | "subscription" | "key" | "unavailable";

/**
 * Which picker section a preset sits under. The picker chunks PRESETS by
 * scanning runs, never sorting, so a section must stay one run: a row parked
 * out of place would open a second heading of the same name.
 */
export function presetSection(preset: ProviderPreset): PresetSection {
  if (preset.disabled) return "unavailable";
  // Antigravity's free quota is a display fact, not Zen's transport behavior.
  if (preset.id === "antigravity" || preset.free) return "free";
  return preset.auth === "oauth" ? "subscription" : "key";
}

/**
 * The product's own name — "Claude", "Anthropic", "DeepSeek". The preset's
 * current name wins over the copy saved into the config at add time, so
 * renaming a preset shows up everywhere without asking the user to re-save.
 *
 * For surfaces whose surrounding copy already says how the provider is paid
 * for: the picker under its section header, the sign-in card ("Sign in with
 * Claude"), a form already sitting on one row's edit path.
 */
export function providerName(provider: { id: string; name: string }): string {
  return PRESETS.find((p) => p.id === provider.id)?.name ?? provider.name;
}

/**
 * Label for a stored provider, qualified by how it's paid for wherever the
 * name alone is ambiguous — a chat header offering both Kimi rows, or a list
 * where "Claude" next to "Anthropic" doesn't say which quota a run spends.
 * Everything unpaired reads as its bare name.
 */
export function providerDisplayName(provider: { id: string; name: string }): string {
  const preset = PRESETS.find((p) => p.id === provider.id);
  if (!preset?.paired) return providerName(provider);
  // Localized both ways — "API key" is a phrase, not the bare acronym, because
  // it's the half of the pair a first-timer has to be taught.
  const how = preset.auth === "oauth" ? i18n.t("common.subscription") : i18n.t("common.apiKey");
  return `${preset.name} (${how})`;
}
