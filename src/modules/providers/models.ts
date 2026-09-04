import type { ModelInfo, ProviderConfig, ResolvedProviderConfig } from "./types";
import { ProviderError } from "./types";
import { PRESETS } from "./presets";
import { apiUrl, classifyHttp } from "@providerkit/core";
import { anthropicHeaders, anthropicOAuthHeaders } from "./http";
import { i18n } from "@/i18n";

/** What a model listing is keyed on — the connection, never the per-task choices. */
export type ModelsTarget = Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth">;

/** The target for a stored config — an OAuth provider lists with its access token as bearer. */
export function modelsTarget(p: ProviderConfig): ModelsTarget {
  return {
    shape: p.shape,
    baseUrl: p.baseUrl,
    apiKey: p.auth?.accessToken ?? p.apiKey,
    ...(p.auth ? { auth: p.auth } : {}),
  };
}

/**
 * Successful listings, cached per connection.
 * ponytail: session-long cache with no expiry — the chip row remounts every
 * time the history view opens and must not refetch identical params. The
 * ceiling is a stale list if the endpoint's models change mid-session;
 * upgrade path is a TTL or revalidating on focus.
 */
const modelsCache = new Map<string, ModelInfo[]>();

export function readModelsCache(target: ModelsTarget): ModelInfo[] | undefined {
  return modelsCache.get(JSON.stringify(target));
}

export function writeModelsCache(target: ModelsTarget, models: ModelInfo[]): void {
  modelsCache.set(JSON.stringify(target), models);
}

/**
 * The models a provider can serve, best-effort and synchronous: this session's
 * live listing when one already landed, else the preset's static list. The
 * slash-command picker can't await — a cold cache narrows to presets instead.
 */
export function knownModels(p: ProviderConfig): ModelInfo[] {
  const cached = readModelsCache(modelsTarget(p));
  if (cached && cached.length > 0) return cached;
  return PRESETS.find((pr) => pr.id === p.id)?.models.map((id) => ({ id })) ?? [];
}

/**
 * Live model listing — the anti-staleness seam. Both wire shapes expose a
 * list route (anthropic: GET {base}/v1/models, openai: GET {base}/models);
 * presets are only the fallback when an endpoint doesn't (QwenCloud 404s).
 */
export async function listModels(
  config: Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth">,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  // The ChatGPT backend (responses shape) exposes no model-list route — the
  // preset's static models are the authoritative list.
  if (config.shape === "responses") return [];
  const url = apiUrl(config.baseUrl, config.shape === "anthropic" ? "/v1/models" : "/models");
  // Signed-in providers list with their access token (OAuth-token mode); key
  // providers with x-api-key. Callers pass an ensureProviderCredential'd config.
  const headers: Record<string, string> =
    config.shape === "anthropic"
      ? config.auth
        ? anthropicOAuthHeaders(config.apiKey)
        : anthropicHeaders(config.apiKey)
      : { Authorization: `Bearer ${config.apiKey}` };

  const res = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      i18n.t("errors.modelListError", { status: res.status, detail: text || res.statusText }),
      res.status,
    );
  }

  const entries = parseModelEntries(await res.json());
  return config.shape === "openai" ? entries.filter((m) => !isNonChatModel(m.id)) : entries;
}

/**
 * Does the endpoint refuse this credential? Checked when a provider is added,
 * with the cheapest authenticated call there is, so a mistyped or wrong-vendor
 * key fails in the form instead of halfway through the user's first task.
 *
 * Only an outright rejection counts as "no". An endpoint with no list route
 * (QwenCloud 404s), an offline machine, or a timed-out check prove nothing
 * about the key — those still add.
 */
export async function isKeyRejected(
  config: Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth">,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await listModels(config, signal);
    return false;
  } catch (e) {
    if (!(e instanceof ProviderError)) return false;
    return classifyHttp(e.status, e.message) === "auth";
  }
}

/**
 * Newest model wins; ties or missing timestamps keep the first entry. The
 * first is the codebase's auto convention everywhere else (the run's
 * `preset.models[0]` fallback, `resolvedModel`, the picker's auto row), and
 * presets and live listings both lead with the newest — so a last-wins tie
 * named the oldest model as "auto" while the run used the newest.
 */
export function pickLatestModel(models: ModelInfo[]): ModelInfo | undefined {
  let best: ModelInfo | undefined;
  for (const m of models) {
    if (!best || (m.created ?? -Infinity) > (best.created ?? -Infinity)) best = m;
  }
  return best;
}

/**
 * Resolve the config's effective model: the user's persisted choice, else the
 * newest the endpoint serves, else the preset's first entry. Throws a clear
 * error when none of the three works — never sends an empty model upstream.
 */
export async function resolveProviderModel(
  config: ProviderConfig,
): Promise<ResolvedProviderConfig> {
  // Image support is a property of the family, not the model — no endpoint
  // ships per-model vision flags, so the preset is the single source.
  const preset = PRESETS.find((p) => p.id === config.id);
  const supportsImages = preset?.supportsImages ?? true;

  if (config.model) return { ...config, model: config.model, supportsImages };

  try {
    const latest = pickLatestModel(await listModels(config));
    if (latest) return { ...config, model: latest.id, supportsImages };
  } catch {
    // Endpoint has no list route (or is unreachable) — fall through to preset.
  }

  const presetFallback = preset?.models[0];
  if (presetFallback) return { ...config, model: presetFallback, supportsImages };

  throw new ProviderError(i18n.t("errors.noModel", { name: config.name }), 0);
}

function parseModelEntries(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ProviderError(i18n.t("errors.noModelData"), 0);
  const out: ModelInfo[] = [];
  for (const entry of data) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) continue;
    out.push({
      id,
      name: parseName(record, id),
      created: parseCreated(record),
      contextLength: parseContextLength(record),
    });
  }
  return out;
}

/** Anthropic lists `display_name`, OpenRouter-style endpoints list `name`; plain OpenAI has neither. */
function parseName(entry: Record<string, unknown>, id: string): string | undefined {
  for (const key of ["display_name", "name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() && value !== id) return value.trim();
  }
  return undefined;
}

/**
 * The context window, when the endpoint volunteers it. OpenRouter ships
 * `context_length`, LM Studio `max_context_length`, Ollama `context_window` —
 * Anthropic and OpenAI ship none, which is why this is only one rung of the
 * ladder in context-window.ts and never the whole answer.
 */
function parseContextLength(entry: Record<string, unknown>): number | undefined {
  for (const key of ["context_length", "max_context_length", "context_window"]) {
    const value = entry[key];
    // Below 1k is a unit we don't recognize (or a broken listing), not a window.
    if (typeof value === "number" && Number.isFinite(value) && value >= 1_000) return value;
  }
  return undefined;
}

/** Endpoints report `created` (unix s) and/or `created_at` (ISO) — normalize to ms. */
function parseCreated(entry: Record<string, unknown>): number | undefined {
  if (typeof entry.created === "number" && Number.isFinite(entry.created)) {
    return entry.created * 1000;
  }
  if (typeof entry.created_at === "string") {
    const ms = Date.parse(entry.created_at);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

// ponytail: name heuristic — big OpenAI-shape catalogs (OpenAI, OpenRouter,
// Gemini) mix embeddings/tts/image/live/realtime models into /models. Ceiling:
// a chat model with an unlucky name gets hidden; it stays reachable via free-text entry.
const NON_CHAT_PATTERN =
  /embed|whisper|tts|dall-e|image|moderation|realtime|audio|transcrib|search-preview|-live|veo|robot|research|computer-use/i;

function isNonChatModel(id: string): boolean {
  return NON_CHAT_PATTERN.test(id);
}
