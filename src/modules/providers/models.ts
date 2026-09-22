import type { ModelInfo, ProviderConfig, ResolvedProviderConfig } from "./types";
import { ProviderError } from "./types";
import { PRESETS } from "./presets";
import type { ProviderPreset } from "./presets";
import { apiUrl, classifyHttp } from "@providerkit/core";
import { anthropicHeaders, anthropicOAuthHeaders, providerHeaders } from "./http";
import { ensureProviderCredential } from "./credential";
import { i18n } from "@/i18n";

/** What a model listing is keyed on — the connection, never the per-task choices. */
export type ModelsTarget = Pick<ProviderConfig, "id" | "shape" | "baseUrl" | "apiKey" | "auth">;

/** The target for a stored config — an OAuth provider lists with its access token as bearer. */
export function modelsTarget(p: ProviderConfig): ModelsTarget {
  return {
    id: p.id,
    shape: p.shape,
    // The host the credential is pinned to when the vendor picked one per
    // account (GitHub Copilot), else the preset's own.
    baseUrl: p.auth?.baseUrl ?? p.baseUrl,
    apiKey: p.auth?.accessToken ?? p.apiKey,
    ...(p.auth ? { auth: p.auth } : {}),
  };
}

/**
 * List a stored provider's models, renewing its credential first.
 *
 * The picker reads the config straight out of storage, so its access token is
 * only as fresh as the last run left it — and GitHub Copilot's lasts 25
 * minutes. Listing with a dead one falls back to the preset's cold-start
 * models, which is the picker quietly hiding most of the account's catalog.
 */
export async function listStoredModels(
  p: ProviderConfig,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  return listModels(modelsTarget(await ensureProviderCredential(p)), signal);
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
  // `id` is optional because the add form checks a key it has not named yet —
  // and a provider with no id has no preset, so no extra headers either.
  config: Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth"> & { id?: string },
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
      : { Authorization: `Bearer ${config.apiKey}`, ...providerHeaders(config.id ?? "") };

  const res = await fetch(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      i18n.t("errors.modelListError", { status: res.status, detail: text || res.statusText }),
      res.status,
    );
  }

  const entries = parseModelEntries(await res.json(), config.id);
  return config.shape === "openai" ? entries.filter((m) => !isNonChatModel(m.id)) : entries;
}

/**
 * Spend a credential once: list with it, and report both halves — whether the
 * endpoint refuses it, and what it serves. The add form checks the key before
 * storing it AND warms the picker's cache with the same listing, so the panel
 * opens on the live shelf instead of the preset fallback; without the
 * hand-off the check's fetch is thrown away and the picker pays for a second
 * one (or shows stale presets when that one fails).
 *
 * Only an outright rejection counts as "no". An endpoint with no list route
 * (QwenCloud 404s), an offline machine, or a timed-out check prove nothing
 * about the key — those still add, with no models to warm.
 */
export async function checkCredential(
  config: Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth"> & { id?: string },
  signal?: AbortSignal,
): Promise<{ rejected: boolean; models: ModelInfo[] }> {
  try {
    return { rejected: false, models: await listModels(config, signal) };
  } catch (e) {
    if (!(e instanceof ProviderError)) return { rejected: false, models: [] };
    return { rejected: classifyHttp(e.status, e.message) === "auth", models: [] };
  }
}

/**
 * Does the endpoint refuse this credential? Checked when a provider is added,
 * with the cheapest authenticated call there is, so a mistyped or wrong-vendor
 * key fails in the form instead of halfway through the user's first task.
 */
export async function isKeyRejected(
  config: Pick<ProviderConfig, "shape" | "baseUrl" | "apiKey" | "auth"> & { id?: string },
  signal?: AbortSignal,
): Promise<boolean> {
  return (await checkCredential(config, signal)).rejected;
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
 *
 * Gateway presets (OpenCode Zen/Go) serve different models on different wire
 * endpoints, so the resolution also carries the model's own shape and base —
 * see routeModel. The stored config keeps the preset's shape; only the
 * run-time resolution is rerouted.
 */
export async function resolveProviderModel(
  config: ProviderConfig,
): Promise<ResolvedProviderConfig> {
  // Image support is a property of the family, not the model — no endpoint
  // ships per-model vision flags, so the preset is the single source.
  const preset = PRESETS.find((p) => p.id === config.id);
  const supportsImages = preset?.supportsImages ?? true;

  const model = await resolveModelId(config, preset);
  return { ...config, model, supportsImages, ...routeModel(preset, config.baseUrl, model) };
}

/** The model id, before routing: persisted choice, else newest listed, else preset fallback. */
async function resolveModelId(
  config: ProviderConfig,
  preset: ProviderPreset | undefined,
): Promise<string> {
  if (config.model) return config.model;

  try {
    const latest = pickLatestModel(await listModels(config));
    if (latest) return latest.id;
  } catch {
    // Endpoint has no list route (or is unreachable) — fall through to preset.
  }

  const presetFallback = preset?.models[0];
  if (presetFallback) return presetFallback;

  throw new ProviderError(i18n.t("errors.noModel", { name: config.name }), 0);
}

/**
 * The wire endpoint a gateway model actually lives on. Both Zen rows share
 * one base (`…/zen/v1`) for completions and Responses; the Anthropic Messages
 * endpoint sits one level up (`…/zen/v1/messages`), so a routed model sheds
 * the `/v1` suffix the preset carries and the adapter re-appends its own
 * `/v1/messages`. Unlisted models stay on the preset's shape and base —
 * today's behaviour, never a regression.
 */
function routeModel(
  preset: ProviderPreset | undefined,
  baseUrl: string,
  model: string,
): Pick<ResolvedProviderConfig, "shape" | "baseUrl"> | undefined {
  if (!preset?.modelRoutes) return undefined;
  if (preset.modelRoutes.responses?.includes(model)) return { shape: "responses", baseUrl };
  if (preset.modelRoutes.anthropic?.includes(model)) {
    return { shape: "anthropic", baseUrl: baseUrl.replace(/\/v1\/?$/, "") };
  }
  return undefined;
}

function parseModelEntries(body: unknown, providerId?: string): ModelInfo[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ProviderError(i18n.t("errors.noModelData"), 0);
  const raws: Record<string, unknown>[] = [];
  for (const entry of data) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) continue;
    raws.push(record);
  }
  // GitHub Copilot lists every model the API knows, not every model the
  // account may serve — picking a disabled one answers `model_not_supported`
  // at run time. Same filter pi applies on the same endpoint: only
  // picker-enabled models whose policy isn't disabled, falling back to
  // policy-enabled ones when no picker flag is set at all (some Individual
  // accounts report false for every flag despite explicit enabled policies).
  // Models without tool-call support are dropped either way — an agent that
  // cannot call tools is not a runnable engine.
  const kept =
    providerId === "github-copilot" ? filterCopilotEntries(raws) : raws;
  return kept.map((record) => {
    const id = record.id as string;
    return {
      id,
      name: parseName(record, id),
      created: parseCreated(record),
      contextLength: parseContextLength(record),
    };
  });
}

/**
 * Which Copilot `/models` entries the account can actually run. Mirrors pi's
 * `parseGitHubCopilotModelCatalog` on the same response shape.
 */
function filterCopilotEntries(raws: Record<string, unknown>[]): Record<string, unknown>[] {
  const usable = raws.filter((record) => {
    const supports = (
      (record.capabilities as Record<string, unknown> | undefined)?.supports as
        | Record<string, unknown>
        | undefined
    )?.tool_calls;
    return supports !== false;
  });
  const picked = usable.filter(
    (record) =>
      record.model_picker_enabled === true &&
      (record.policy as Record<string, unknown> | undefined)?.state !== "disabled",
  );
  if (picked.length > 0) return picked;
  const enabled = usable.filter(
    (record) => (record.policy as Record<string, unknown> | undefined)?.state === "enabled",
  );
  return enabled.length > 0 ? enabled : usable;
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
