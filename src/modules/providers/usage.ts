import { ensureProviderCredential } from "./credential";
import { classifyHttp } from "@providerkit/core";
import { str } from "./oauth";
import { providerDisplayName } from "./presets";
import { ProviderError } from "./types";
import type { ProviderConfig } from "./types";
import { createLogger, truncate } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("usage");

/** Kimi serializes quota numbers as strings — accept both. */
const toNum = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/**
 * How much of a subscription window is spent. All three OAuth presets expose
 * this through an (undocumented) usage endpoint — the same ones Claude Code's
 * `/usage`, Codex's status, and kimi-cli's `/usage` call:
 *
 * - claude    GET api.anthropic.com/api/oauth/usage — { five_hour, seven_day }
 * - chatgpt   GET chatgpt.com/backend-api/wham/usage — primary(5h)/secondary(weekly) windows
 * - kimi-plan GET api.kimi.ai/coding/v1/usages — limits[0] (5h) + usage (weekly)
 *
 * Being unofficial, shapes drift — parsers omit any window they can't read
 * rather than fail, and the UI shows what arrived.
 */
export interface UsageWindow {
  /** 0–100, clamped. */
  usedPercent: number;
  resetsAtMs?: number;
}

export interface ProviderUsage {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  /** Plan tier when the endpoint names it ("plus", "allegretto") — display only. */
  plan?: string;
  fetchedAt: number;
}

const USAGE_URLS: Record<string, string> = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  chatgpt: "https://chatgpt.com/backend-api/wham/usage",
  "kimi-plan": "https://api.kimi.ai/coding/v1/usages",
};

/** Only the OAuth (subscription) presets have usage windows to show. */
export function supportsUsage(providerId: string): boolean {
  return providerId in USAGE_URLS;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function percent(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** Reset timestamps arrive as RFC 3339 strings or epoch seconds, depending on the endpoint. */
function resetMs(value: unknown): number | undefined {
  const text = str(value);
  if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return at;
  }
  const epoch = toNum(value);
  if (epoch === undefined || epoch <= 0) return undefined;
  // Seconds vs ms: anything before 2001 in ms is clearly seconds.
  return epoch < 1_000_000_000_000 ? epoch * 1000 : epoch;
}

function windowOf(
  usedPercent: number | undefined,
  resetsAtMs: number | undefined,
): UsageWindow | undefined {
  if (usedPercent === undefined) return undefined;
  return resetsAtMs === undefined ? { usedPercent } : { usedPercent, resetsAtMs };
}

/** Claude: { five_hour: { utilization, resets_at }, seven_day: {…} } — utilization is 0–100. */
export function parseClaudeUsage(body: unknown): Omit<ProviderUsage, "fetchedAt"> {
  if (!isRecord(body)) return {};
  const read = (key: string): UsageWindow | undefined => {
    const w = body[key];
    if (!isRecord(w)) return undefined;
    return windowOf(toNum(w.utilization), resetMs(w.resets_at));
  };
  const fiveHour = read("five_hour");
  const weekly = read("seven_day");
  return { ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) };
}

/** ChatGPT: { plan_type, rate_limit: { primary_window: { used_percent }, secondary_window: {…} } }. */
export function parseChatGptUsage(body: unknown): Omit<ProviderUsage, "fetchedAt"> {
  if (!isRecord(body)) return {};
  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : {};
  const read = (key: string): UsageWindow | undefined => {
    const w = rateLimit[key];
    if (!isRecord(w)) return undefined;
    return windowOf(toNum(w.used_percent), resetMs(w.resets_at ?? w.reset_at));
  };
  const fiveHour = read("primary_window");
  const weekly = read("secondary_window");
  const plan = str(body.plan_type);
  return {
    ...(fiveHour && { fiveHour }),
    ...(weekly && { weekly }),
    ...(plan && { plan }),
  };
}

/**
 * Kimi: { user.membership.level, usage: weekly { limit, used, remaining, resetTime },
 * limits: [{ window: { duration, timeUnit }, detail: 5h {…} }] } — numbers as strings.
 */
export function parseKimiUsage(body: unknown): Omit<ProviderUsage, "fetchedAt"> {
  if (!isRecord(body)) return {};
  const read = (w: unknown): UsageWindow | undefined => {
    if (!isRecord(w)) return undefined;
    const limit = toNum(w.limit);
    const used = toNum(w.used);
    const remaining = toNum(w.remaining);
    const usedPercent =
      percent(used, limit) ??
      (limit !== undefined && remaining !== undefined
        ? percent(limit - remaining, limit)
        : undefined);
    return windowOf(usedPercent, resetMs(w.resetTime ?? w.reset_at));
  };
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const first = limits[0];
  const fiveHour = read(isRecord(first) ? first.detail : undefined);
  const weekly = read(body.usage);
  const plan =
    isRecord(body.user) && isRecord(body.user.membership)
      ? str(body.user.membership.level)
      : str(body.subType);
  return {
    ...(fiveHour && { fiveHour }),
    ...(weekly && { weekly }),
    ...(plan && { plan }),
  };
}

const PARSERS = {
  claude: parseClaudeUsage,
  chatgpt: parseChatGptUsage,
  "kimi-plan": parseKimiUsage,
} as const;

/**
 * Fetch the provider's live window state. `ensureProviderCredential` first —
 * an expired access token refreshes (and persists) here exactly as at run
 * start. Throws a classified ProviderError on non-2xx so the UI can offer the
 * sign-in fix for a dead credential.
 */
export async function fetchProviderUsage(provider: ProviderConfig): Promise<ProviderUsage> {
  const url = USAGE_URLS[provider.id];
  const parser = PARSERS[provider.id as keyof typeof PARSERS];
  if (!url || !parser) throw new Error(`usage: ${provider.id} has no usage endpoint`);

  const config = await ensureProviderCredential(provider);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  if (provider.id === "claude") headers["anthropic-beta"] = "oauth-2025-04-20";
  if (config.auth?.chatgptAccountId) headers["ChatGPT-Account-Id"] = config.auth.chatgptAccountId;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    log.warn(`usage ${provider.id} HTTP ${res.status}: ${truncate(text)}`);
    const label = providerDisplayName(provider);
    const kind = classifyHttp(res.status, text);
    const message =
      kind === "auth"
        ? i18n.t("errors.kindAuthSignedIn", { provider: label })
        : i18n.t("errors.apiError", {
            provider: label,
            status: res.status,
            detail: truncate(text),
          });
    throw new ProviderError(message, res.status, kind);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderError(i18n.t("errors.usageUnreadable"), res.status);
  }
  return { ...parser(body), fetchedAt: Date.now() };
}
