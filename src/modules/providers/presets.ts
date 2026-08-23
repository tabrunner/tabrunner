import type { ProviderShape } from "./types";
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
   * Set on both rows of a product sold two ways. `name` stays the bare product
   * ("Claude", "Anthropic"); `providerDisplayName` appends which way, so a user
   * holding both a plan and a key always knows which quota a run spends. A
   * product with a single row needs no qualifier — and neither does a surface
   * that already says it, like the picker's own section headers.
   */
  paired?: true;
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
  | "ollama"
  | "mistral"
  | "xai";

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
    models: ["glm-5.2", "glm-4.7"],
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
    models: ["deepseek-chat", "deepseek-reasoner"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    color: "#4D6BFE",
    icon: "deepseek",
    // Text-only API — a screenshot (image_url) in the body is a hard 400.
    supportsImages: false,
  },
  {
    id: "gemini",
    name: "Gemini",
    shape: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
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
    color: "#334155",
    icon: "openrouter",
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
    models: ["grok-4", "grok-4-fast"],
    apiKeyUrl: "https://console.x.ai/",
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
