import type { ProviderShape } from "./types";
import { copilotHeaders } from "./github-oauth";
import { i18n } from "@/i18n";

/** Preset provider — just data, no code. Adding a provider starts here. */
export interface ProviderPreset {
  id: string;
  name: string;
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
   * Set on a KEYED row whose vendor can also mint that key through a sign-in.
   * The form then offers both, and the user picks. Distinct from `auth` on
   * purpose: `auth` says the provider is paid for a different way and so earns
   * its own row, while this says the very same key can be fetched without a
   * trip to the console. OpenRouter is the only one — its sign-in ends in an
   * ordinary API key on the same account, billed from the same credits.
   */
  signIn?: true;
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
   * OpenCode's gateway wants its per-conversation routing header on every chat
   * turn (`x-opencode-session`, the conversation id) — the same header pi's
   * opencode providers send. Without it the free tier answers
   * `FreeTierError: can only be used from within OpenCode`. Both Zen rows,
   * which share the one backend and the one key.
   *
   * What we deliberately DON'T mirror from opencode/pi: `User-Agent:
   * opencode/<version>` (a browser extension cannot set it — Chrome owns that
   * header on fetch), and `x-opencode-request` / `x-opencode-client` /
   * `x-opencode-project` (opencode's own user/project identities, which a
   * pasted key doesn't carry). The session header is the one the free-tier
   * gate reads.
   */
  sessionHeader?: true;
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
 * on: the subscriptions lead, because a plan someone already pays for is the
 * shortest path to a working provider — an API key means a console, a credit
 * card, and a billing decision before the first task ever runs. The OAuth rows
 * being contiguous is what lets the picker chunk this list into its two
 * sections without sorting it.
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
    // The Codex agent backend behind a ChatGPT Plus/Pro sign-in instead of a
    // key — the same quota your ChatGPT subscription pays for. It speaks the
    // Responses wire format at a backend with no public model-list route, so
    // the preset models ARE the picker's list.
    id: "chatgpt",
    name: "ChatGPT",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    models: ["gpt-5.4-mini", "gpt-5.5", "gpt-5.3-codex", "gpt-5.1-codex-max"],
    auth: "oauth",
    paired: true,
    inlineToolImages: true,
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
    // meta-oauth.ts. Responses shape, but the published one, not codex's.
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
    // and a base URL the account's own plan names — see github-oauth.ts. The
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
    headers: copilotHeaders,
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
    // stays one row. See openrouter-oauth.ts.
    signIn: true,
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
    // A gateway, like OpenRouter: one key, many vendors' models — and the only
    // endpoint here that serves a standing shelf of $0 models. The picker's
    // live listing is the real catalog; these are the fallback, led by the
    // contributor-tier Spark (free, agentic, and the shelf's steadiest free
    // id). The free shelf rotates — these are the ids OpenCode's own Zen docs
    // name right now, so a cold open never offers a model the endpoint already
    // retired (a dead free id answers 500).
    //
    // Free means $0 per token, NOT no card: an OpenCode account wants billing
    // details before it issues a key at all. `apiKeyUrl` goes where that is
    // set up.
    id: "opencode",
    name: "OpenCode Zen",
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    models: [
      "muse-spark-1.3-contributor-free",
      "mimo-v2.5-free",
      "mimo-v2.6-flash-free",
      "glm-5.3",
      "claude-sonnet-5",
      "gpt-5.4",
    ],
    apiKeyUrl: "https://opencode.ai/auth",
    sessionHeader: true,
    // Per OpenCode's Zen docs: GPT/Grok/Muse-Spark live on /responses,
    // Claude/Qwen on /messages. (Gemini lives on its own Google endpoint,
    // which this extension has no adapter for — those ids stay on chat
    // completions and fail loudly rather than silently.)
    modelRoutes: {
      responses: [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.2",
        "gpt-5.2-codex",
        "gpt-5.1",
        "gpt-5.1-codex",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-mini",
        "gpt-5",
        "gpt-5-codex",
        "gpt-5-nano",
        "grok-4.7",
        "grok-4.6",
        "grok-4.5",
        "grok-build-0.1",
        "muse-spark-1.3",
        "muse-spark-1.2",
        "muse-spark-1.3-contributor-free",
      ],
      anthropic: [
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-opus-4-5",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus",
        "qwen3.5-plus",
      ],
    },
    color: "#171717",
    icon: "opencode",
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
    models: ["glm-5.3", "kimi-k2.6", "qwen3.8-max", "mimo-v2.5"],
    apiKeyUrl: "https://opencode.ai/auth",
    sessionHeader: true,
    // Per OpenCode's Go docs, with pi's correction: pi reroutes minimax-m2.7
    // and qwen3.5/3.6-plus to chat completions (their Go endpoints want Bearer
    // on /chat/completions despite what models.dev claims), so only the ids
    // below ride /messages and /responses.
    modelRoutes: {
      responses: [
        "grok-4.5",
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
