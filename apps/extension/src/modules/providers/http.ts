import type { ChatMessage, ProviderConfig, ResolvedProviderConfig } from "./types";
import { ProviderError } from "./types";
import {
  classifyHttp,
  isOpenCodeFreeLimit,
  isTransportFailure,
  parseRateLimitReset,
  parseSseStream,
  parseUsageLimitBody,
  ProviderError as CoreProviderError,
  type ErrorKind,
  type RateLimitReset,
} from "@providerkit/core";
import { formatResetRelative } from "./rate-limit";
import { PRESETS, providerDisplayName } from "./presets";
import { zenSessionHeaders } from "./zen";
import { createLogger, truncate } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("providers");

/** Enough of a provider to name it and to know how it authenticates. */
export type ProviderIdentity = Pick<ProviderConfig, "id" | "name" | "auth">;

/**
 * The wording for each kind, or `null` for the ones that keep the generic
 * envelope. Since the classifier moved to @providerkit/core it answers with
 * all thirteen kinds rather than eight-or-undefined, and three of the new ones
 * have nothing to add: `invalid` and `unknown` ARE their body, and telling a
 * user "the request was malformed" hides the message that says how. They land
 * exactly where they landed when the classifier returned undefined.
 *
 * Still exhaustive on purpose. A kind added upstream should fail this build
 * and make someone decide, rather than silently fall through to a status code.
 */
const ERROR_KIND_KEYS = {
  entitlement: "errors.kindEntitlement",
  quota: "errors.kindQuota",
  auth: "errors.kindAuth",
  model: "errors.kindModel",
  rate: "errors.kindRate",
  overload: "errors.kindOverload",
  context: "errors.kindContext",
  timeout: "errors.kindTimeout",
  content: "errors.kindContent",
  // Unreachable from here: a `network` failure has no response to classify.
  // Present because the map is exhaustive over the union, and the host-less
  // wording is the right fallback if it ever did arrive this way.
  network: "errors.kindNetwork",
  // The body carries the remedy; a generic line would bury it.
  invalid: null,
  unknown: null,
  // A stopped run is not a failure and never reaches this function.
  aborted: null,
} as const satisfies Record<ErrorKind, string | null>;

const WINDOW_KEYS = {
  "5h": "errors.window5h",
  weekly: "errors.windowWeekly",
  monthly: "errors.windowMonthly",
} as const satisfies Record<NonNullable<RateLimitReset["window"]>, string>;

/**
 * OpenCode's data-policy gate: some gateway models train on run data and
 * refuse until the account accepts at the workspace URL the error carries.
 * It is NOT a bad key (the classified auth wording would send the user to
 * replace a working credential), so it gets its own lead line naming the
 * actual fix, and no kind: nothing to retry, compact, or re-key. The consent
 * anchor in the chat reads this same helper, so the button and the copy can
 * never disagree about which URL to open.
 */
export function dataPolicyConsentUrl(text: string): string | undefined {
  if (!/DataPolicyError/i.test(text)) return undefined;
  const raw = /https:\/\/[^\s"'{}]+/.exec(text)?.[0];
  if (!raw) return undefined;
  // Trailing prose punctuation is not part of the link.
  return raw.replace(/[).,.]+$/, "");
}

/**
 * The lead line for a rate or quota answer. "Try again in a moment" is only
 * honest for a per-minute throttle. When the response names a subscription
 * window (Claude OAuth 5-hour/weekly via headers, ChatGPT via its `x-codex-*`
 * headers and the body) or any reset time, say when it actually resets.
 *
 * A spent window is as often `quota` as `rate`: the classifier names ChatGPT's
 * `usage_limit_reached` 429 a quota, and that is the answer whose reset time a
 * subscriber most needs. Without a window the quota line stands (a drained
 * balance has no reset to name).
 */
function limitLine(
  label: string,
  kind: "rate" | "quota",
  reset: RateLimitReset,
  now: number,
): string {
  if (reset.window && reset.resetAtMs !== undefined) {
    return i18n.t("errors.kindRateWindow", {
      provider: label,
      window: i18n.t(WINDOW_KEYS[reset.window]),
      reset: formatResetRelative(reset.resetAtMs, now),
    });
  }
  if (kind === "quota") return i18n.t(ERROR_KIND_KEYS.quota, { provider: label });
  if (reset.resetAtMs !== undefined) {
    return i18n.t("errors.kindRateRetry", {
      provider: label,
      reset: formatResetRelative(reset.resetAtMs, now),
    });
  }
  return i18n.t(ERROR_KIND_KEYS.rate, { provider: label });
}

/**
 * Classified errors lead with what fixes them ("rejected the API key...") and
 * keep the raw body after a colon, so splitErrorDetail still lifts the
 * provider's own line into the summary and the JSON behind Details.
 *
 * A signed-in provider holds no key, so the auth line names the fix it
 * actually has: signing in again.
 */
function providerErrorMessage(
  provider: ProviderIdentity,
  status: number,
  text: string,
  fallbackDetail: string,
  reset: RateLimitReset,
  now: number,
  kind: ErrorKind,
): { message: string; kind?: ErrorKind } {
  const label = providerDisplayName(provider);
  if (provider.id === "opencode" && isOpenCodeFreeLimit(text)) {
    const line =
      reset.resetAtMs === undefined
        ? i18n.t("errors.zenFreeLimit")
        : i18n.t("errors.zenFreeLimitReset", {
            reset: formatResetRelative(reset.resetAtMs, now),
          });
    return { message: text ? `${line}: ${text}` : line, kind: "quota" };
  }
  // The data-policy gate is checked before classification: its body would
  // otherwise classify as auth ("rejected the key"), which misdiagnoses a
  // working credential and offers re-keying as the fix.
  const consentUrl = dataPolicyConsentUrl(text);
  if (consentUrl) {
    return {
      message: `${i18n.t("errors.dataPolicy", { provider: label, url: consentUrl })}: ${text}`,
    };
  }
  const key = ERROR_KIND_KEYS[kind];
  if (key) {
    const line =
      kind === "rate" || kind === "quota"
        ? limitLine(label, kind, reset, now)
        : i18n.t(kind === "auth" && provider.auth ? "errors.kindAuthSignedIn" : key, {
            provider: label,
          });
    return { message: text ? `${line}: ${text}` : line, kind };
  }
  return {
    message: i18n.t("errors.apiError", {
      provider: label,
      status,
      detail: text || fallbackDetail,
    }),
  };
}

/**
 * The failure for a request that never reached the provider. It gets a lead
 * line of its own because the generic envelope blames the wrong actor: the
 * provider never heard us, so "the provider couldn't do that" is a sentence
 * about a server that was never involved.
 *
 * `navigator.onLine === false` is the one definitive signal the browser gives
 * us: no network at all, so say that instead of sending the user to check a
 * base URL that is fine. `true` proves nothing (a captive portal is "online"),
 * which is why it is the branch that names every cause it could be. The
 * comparison is explicit: outside a browser the property is simply absent, and
 * a missing signal must not read as "offline".
 *
 * Status 0: there was no response to have one.
 */
export function networkError(provider: ProviderIdentity, url?: string): ProviderError {
  const label = providerDisplayName(provider);
  const host = hostOf(url);
  let message: string;
  if (navigator.onLine === false) {
    message = i18n.t("errors.kindNetworkOffline", { provider: label });
  } else if (host) {
    message = i18n.t("errors.kindNetworkHost", { provider: label, host });
  } else {
    message = i18n.t("errors.kindNetwork", { provider: label });
  }
  return new ProviderError(message, 0, "network");
}

/**
 * A reply that stopped before its end: the stream closed without the signal
 * that says the turn is over (@providerkit/core's `streamCut`). Still
 * `network`, so the loop retries it while nothing has been shown, but with a
 * line of its own: the request did leave, which is what the network lines deny.
 */
export function streamCutError(provider: ProviderIdentity): ProviderError {
  return new ProviderError(
    i18n.t("errors.kindStreamCut", { provider: providerDisplayName(provider) }),
    0,
    "network",
  );
}

/** The host worth naming, or nothing: a URL we can't parse says nothing useful. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * A provider's own request headers, on top of the credential. GitHub Copilot
 * wants an editor fingerprint and bills differently depending on who started
 * the turn; OpenRouter wants app attribution headers. Everyone else gets an
 * empty object and sends nothing extra.
 *
 * "Who started the turn" is read off the last message: the run's own follow-ups
 * come back carrying tool results, a person's turn ends on theirs. A listing
 * has no messages and is a person clicking the picker, so it counts as theirs.
 */
export function providerHeaders(id: string, messages?: ChatMessage[]): Record<string, string> {
  const build = PRESETS.find((preset) => preset.id === id)?.headers;
  if (!build) return {};
  const last = messages?.[messages.length - 1];
  return build(!last || last.role === "user" ? "user" : "agent");
}

/**
 * The per-conversation header, sent on chat turns for the presets that name
 * one: OpenCode's routing header (`x-opencode-session`, both Zen rows) and the
 * ChatGPT backend's `session-id`. Absent when the preset doesn't ask or the
 * run carries no conversation (a probe outside any chat).
 *
 * OpenCode Zen is the exception: its free tier checks the id's shape, so that
 * row sends the full set OpenCode's own client sends (see zen.ts). Async only
 * for that forge, which hashes.
 */
export async function sessionHeaders(
  id: string,
  sessionId?: string,
): Promise<Record<string, string>> {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset?.sessionHeader || !sessionId) return {};
  if (preset.free) return zenSessionHeaders(sessionId);
  return { [preset.sessionHeader]: sessionId };
}

/**
 * Anthropic dual-auth, shared by /v1/messages and /v1/models: Anthropic reads
 * x-api-key, coding-plan proxies (Kimi, Z.ai, QwenCloud) read Authorization:
 * Bearer. Send both so each server picks its own.
 */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  };
}

/**
 * Anthropic OAuth requests: a subscription credential is a Bearer, not an
 * x-api-key, and the beta header switches the API into OAuth-token mode.
 * Shared by /v1/messages (Claude plan sign-in) and /v1/models.
 */
export function anthropicOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "x-client-request-id": crypto.randomUUID(),
  };
}

/**
 * How much of this turn's prompt the provider served from cache: the only way
 * to answer "is caching actually working", which no amount of reading the
 * request body can tell you.
 *
 * Silent when nothing was cached: a miss on a short prompt is normal and a
 * line per turn saying so is noise.
 */
export function logCacheUsage(total: number, read: number, written = 0): void {
  if (read === 0 && written === 0) return;
  log.debug("prompt cache", {
    hit: `${Math.round((read / Math.max(total, 1)) * 100)}%`,
    read,
    written,
    fresh: Math.max(total - read - written, 0),
  });
}

/**
 * One envelope for every provider failure, whichever adapter caught it: the
 * reset merge (headers authoritative, bodies filling gaps), the classified
 * lead line, the log split (expected states warn, unknown shapes error onto
 * chrome://extensions' Errors page), and the thrown ProviderError.
 */
export function envelopeProviderError(
  provider: ProviderIdentity,
  status: number,
  text: string,
  opts: {
    detail?: string;
    headers?: Headers;
    url?: string;
    unknownAs?: ErrorKind;
    /** `x-should-retry` as a caller already read it. */
    shouldRetry?: boolean;
  } = {},
): ProviderError {
  const now = Date.now();
  const fromHeaders = opts.headers ? parseRateLimitReset(opts.headers, now) : {};
  const fromBody = parseUsageLimitBody(text, now);
  const reset: RateLimitReset = {
    ...(fromHeaders.resetAtMs !== undefined || fromBody.resetAtMs !== undefined
      ? { resetAtMs: fromHeaders.resetAtMs ?? fromBody.resetAtMs }
      : {}),
    ...(fromHeaders.retryAfterMs !== undefined || fromBody.retryAfterMs !== undefined
      ? { retryAfterMs: fromHeaders.retryAfterMs ?? fromBody.retryAfterMs }
      : {}),
    ...(fromHeaders.window || fromBody.window
      ? { window: fromHeaders.window ?? fromBody.window }
      : {}),
  };
  let kind = classifyHttp(status, text);
  if (kind === "unknown" && opts.unknownAs) kind = opts.unknownAs;
  const result = providerErrorMessage(provider, status, text, opts.detail ?? "", reset, now, kind);
  logProviderFailure(status, opts.url, text, result.kind);
  const refused = opts.shouldRetry === false || opts.headers?.get("x-should-retry") === "false";
  return new ProviderError(
    result.message,
    status,
    result.kind,
    reset.retryAfterMs,
    refused ? false : undefined,
  );
}

/**
 * Translate a @providerkit/core ProviderError into TabRunner's localized
 * ProviderError envelope, keeping core's classification, reset hints and
 * retry verdict intact.
 */
export function normalizeCoreError(
  config: Pick<ResolvedProviderConfig, "id" | "name" | "auth" | "baseUrl">,
  e: unknown,
  stallMinutes?: number,
): unknown {
  if (!(e instanceof CoreProviderError)) return e;
  if (e.kind === "network") {
    return isTransportFailure(e) || e.message.startsWith("no response from ")
      ? networkError(config, config.baseUrl)
      : streamCutError(config);
  }
  // Core's watchdog timeout (pre-header or post-header stall) carries no HTTP
  // status and no response body: surface TabRunner's stall wording with the
  // exact minute budget and never replay a 6-minute stall.
  if (e.kind === "timeout" && e.status === undefined && !e.body && stallMinutes) {
    log.warn(`stream stalled from ${config.baseUrl}: ${truncate(e.message)}`);
    return new ProviderError(
      i18n.t("errors.streamStalled", { minutes: stallMinutes }),
      0,
      "timeout",
      undefined,
      false,
    );
  }
  const now = Date.now();
  const status = e.status ?? 0;
  const text = e.body ?? "";
  const reset: RateLimitReset = {
    ...(e.resetAtMs !== undefined ? { resetAtMs: e.resetAtMs } : {}),
    ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    ...(e.window ? { window: e.window } : {}),
  };
  const { message, kind } = providerErrorMessage(
    config,
    status,
    text,
    e.message,
    reset,
    now,
    e.kind,
  );
  logProviderFailure(status, config.baseUrl, text || e.message, kind);
  return new ProviderError(
    message,
    status,
    kind,
    e.retryAfterMs,
    e.shouldRetry === false ? false : undefined,
  );
}

function logProviderFailure(
  status: number,
  url: string | undefined,
  text: string,
  kind: ErrorKind | undefined,
): void {
  // A classified failure (rate limit, quota, auth...) is an expected provider
  // state the chat already surfaces with its fix. warn keeps it off
  // chrome://extensions' Errors page, which console.error feeds.
  const where = url ?? "request";
  if (kind) {
    log.warn(`HTTP ${status} from ${where}: ${truncate(text)}`);
  } else {
    log.error(`HTTP ${status} from ${where}: ${truncate(text)}`);
  }
}

/**
 * Retained for the Claude plan sign-in adapter (`anthropic.ts`) only: a failure
 * inside a 200 SSE stream, classified through the shared envelope.
 */
export function streamFrameError(provider: ProviderIdentity, error: unknown): ProviderError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const status = typeof code === "number" && code >= 400 ? code : 200;
  return envelopeProviderError(provider, status, JSON.stringify(error) ?? "", {
    unknownAs: "overload",
  });
}

/**
 * Retained for the Claude plan sign-in adapter (`anthropic.ts`) only. All API
 * key and provider-approved sign-in paths stream through @providerkit/core.
 */
export async function* streamSse(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  provider: ProviderIdentity;
  signal: AbortSignal;
  finished?: () => boolean;
  meta?: Record<string, unknown>;
}): AsyncGenerator<string> {
  const { url, headers, body, provider, signal, finished, meta } = opts;
  log.debug("request", { url, bytes: body.length, ...meta });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal,
    });
  } catch (e) {
    if (signal.aborted || !isTransportFailure(e)) throw e;
    log.warn(`no response from ${url}: ${e instanceof Error ? e.message : String(e)}`);
    throw networkError(provider, url);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw envelopeProviderError(provider, res.status, text, {
      detail: res.statusText,
      headers: res.headers,
      url,
    });
  }

  if (!res.body) throw new Error(i18n.t("errors.noResponseBody"));

  yield* parseSseStream(res.body, {
    signal,
    provider: provider.id,
    ...(finished ? { finished } : {}),
  });
}
