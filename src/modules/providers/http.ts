import type { ProviderConfig } from "./types";
import { ProviderError } from "./types";
import { classifyProviderError, isTransportFailure, type ErrorKind } from "./error-classify";
import {
  formatResetRelative,
  parseRateLimitReset,
  parseUsageLimitBody,
  type RateLimitReset,
} from "./rate-limit";
import { providerDisplayName } from "./presets";
import { createLogger, truncate } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("providers");

/** Enough of a provider to name it and to know how it authenticates. */
type ProviderIdentity = Pick<ProviderConfig, "id" | "name" | "auth">;

/** Actionable lead line per failure kind — the raw body still rides along for Details. */
const ERROR_KIND_KEYS = {
  entitlement: "errors.kindEntitlement",
  quota: "errors.kindQuota",
  auth: "errors.kindAuth",
  model: "errors.kindModel",
  rate: "errors.kindRate",
  overload: "errors.kindOverload",
  context: "errors.kindContext",
  // Unreachable from here — a `network` failure has no response to classify.
  // Present because the map is exhaustive over the union, and the host-less
  // wording is the right fallback if it ever did arrive this way.
  network: "errors.kindNetwork",
} as const satisfies Record<ErrorKind, string>;

const WINDOW_KEYS = {
  "5h": "errors.window5h",
  weekly: "errors.windowWeekly",
  monthly: "errors.windowMonthly",
} as const satisfies Record<NonNullable<RateLimitReset["window"]>, string>;

/**
 * The rate-limit lead line. "Try again in a moment" is only honest for a
 * per-minute throttle — when the response names a subscription window (Claude
 * OAuth 5-hour/weekly via headers, ChatGPT via the body) or any reset time,
 * say when it actually resets.
 */
function rateLimitLine(label: string, reset: RateLimitReset, now: number): string {
  if (reset.window && reset.resetAtMs !== undefined) {
    return i18n.t("errors.kindRateWindow", {
      provider: label,
      window: i18n.t(WINDOW_KEYS[reset.window]),
      reset: formatResetRelative(reset.resetAtMs, now),
    });
  }
  if (reset.resetAtMs !== undefined) {
    return i18n.t("errors.kindRateRetry", {
      provider: label,
      reset: formatResetRelative(reset.resetAtMs, now),
    });
  }
  return i18n.t(ERROR_KIND_KEYS.rate, { provider: label });
}

/**
 * Classified errors lead with what fixes them ("rejected the API key — check
 * it…") and keep the raw body after a colon, so splitErrorDetail still lifts
 * the provider's own line into the summary and the JSON behind Details.
 *
 * A signed-in provider holds no key, so the auth line names the fix it
 * actually has — signing in again.
 */
function providerErrorMessage(
  provider: ProviderIdentity,
  status: number,
  text: string,
  fallbackDetail: string,
  reset: RateLimitReset,
  now: number,
): { message: string; kind?: ErrorKind } {
  const label = providerDisplayName(provider);
  const kind = classifyProviderError(status, text);
  if (kind) {
    const line =
      kind === "rate"
        ? rateLimitLine(label, reset, now)
        : i18n.t(
            kind === "auth" && provider.auth ? "errors.kindAuthSignedIn" : ERROR_KIND_KEYS[kind],
            {
              provider: label,
            },
          );
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
 * us — no network at all, so say that instead of sending the user to check a
 * base URL that is fine. `true` proves nothing (a captive portal is "online"),
 * which is why it is the branch that names every cause it could be. The
 * comparison is explicit: outside a browser the property is simply absent, and
 * a missing signal must not read as "offline".
 *
 * Status 0 — there was no response to have one.
 */
export function networkError(provider: ProviderIdentity, url?: string): ProviderError {
  const label = providerDisplayName(provider);
  const host = hostOf(url);
  const message =
    navigator.onLine === false
      ? i18n.t("errors.kindNetworkOffline", { provider: label })
      : host
        ? i18n.t("errors.kindNetworkHost", { provider: label, host })
        : i18n.t("errors.kindNetwork", { provider: label });
  return new ProviderError(message, 0, "network");
}

/** The host worth naming, or nothing — a URL we can't parse says nothing useful. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Base + path joined once — trailing slashes on stored base URLs would double up. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

/**
 * Anthropic dual-auth, shared by /v1/messages and /v1/models: Anthropic reads
 * x-api-key, coding-plan proxies (Kimi, Z.ai, QwenCloud) read Authorization:
 * Bearer — send both, each server picks its own.
 */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  };
}

/**
 * Anthropic OAuth requests — a subscription credential is a Bearer, not an
 * x-api-key, and the beta header is what switches the API into OAuth-token
 * mode. Shared by /v1/messages and /v1/models.
 *
 * Origin is stripped from the request itself (see origin.ts): Anthropic's CORS
 * gate refuses an OAuth token that arrives with any browser Origin, and the
 * old `anthropic-dangerous-direct-browser-access` header was never honored at
 * an extension one — it exists for first-party web callers. A CLI sends no
 * Origin; our request now looks the same way.
 *
 * The two Claude Code fingerprint headers ride along for free. The full set
 * (X-App, X-Stainless-*, Session-Id) is deliberately NOT impersonated — those
 * advertise a Node runtime we don't have, and a token from a browser client is
 * a first-party thing, not a leak. opencodex's client-fingerprint.ts is the
 * upgrade path if Anthropic ever starts rejecting clean OAuth requests.
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
 * Tool-call args arrive in fragments and may end mid-JSON — parse defensively.
 *
 * A provider that hits its output limit cuts the stream mid-arguments, so the
 * raw text is `{ "summary": "the whole answer…` with no closing brace. JSON.parse
 * throws on that, and the caller used to get {} — which is how a run that wrote
 * its entire final report into `done.summary` surfaced as a hollow "task
 * complete": the answer was there, in the fragments, and got thrown away. On a
 * parse failure, salvage any string fields — the ones that closed before the
 * cut, and the one left open by it, whose content up to the cut is the answer.
 *
 * Both paths end in healUnicodeEscapes: a clean parse is not enough when the
 * model escaped its own accents twice.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return healArgs(salvageStringArgs(raw));
  }
  // A non-object args payload is a protocol violation, not a value to pass on.
  return healArgs(isRecord(parsed) ? parsed : {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How much of this turn's prompt the provider served from cache — the only way
 * to answer "is caching actually working", which no amount of reading the
 * request body can tell you.
 *
 * `total` is every input token the turn billed for, however it billed. The two
 * shapes disagree about what they hand back: Anthropic reports reads and writes
 * as fields of their own, *excluding* both from `input_tokens`; the OpenAI
 * shapes report `cached_tokens` as a subset already inside the input count and
 * never disclose writes. Passing the reconciled total keeps `fresh` honest on
 * both.
 *
 * Silent when nothing was cached — a miss on a short prompt is normal (every
 * shape has a minimum prefix worth caching) and a line per turn saying so is
 * noise.
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
 * Most models write non-ASCII inside tool-call JSON as `\uXXXX` — legal, and
 * JSON.parse turns it back into the character. Some escape it twice: they emit
 * `\\u00e7`, so even a correct parse leaves the six literal characters standing
 * and a Portuguese answer reaches the user as `aten\u00e7\u00e3o`. Decode
 * whatever survived the parse.
 *
 * `\uXXXX` only. An answer that legitimately spells that sequence is vanishingly
 * rare; one that mentions `\n` while talking about code is not.
 */
const UNICODE_ESCAPE = /\\u([0-9a-fA-F]{4})/g;

function healUnicodeEscapes(s: string): string {
  return s.replace(UNICODE_ESCAPE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** healUnicodeEscapes across every string in an args object, nested included. */
function healArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = healValue(value);
  return out;
}

function healValue(value: unknown): unknown {
  if (typeof value === "string") return healUnicodeEscapes(value);
  if (Array.isArray(value)) return value.map(healValue);
  if (isRecord(value)) return healArgs(value);
  return value;
}

/**
 * Best-effort recovery of `"key": "value"` string fields from truncated JSON.
 * Only strings: they are what a `done` summary (the field worth rescuing) is
 * made of, and a closing quote is the one reliable boundary in a partial
 * stream. Numbers/booleans/objects are dropped — a salvaged half-value would be
 * worse than none. Fields that closed before the cut are kept; the single field
 * the cut left open (the summary) keeps its content up to the cut — a half-said
 * answer beats a thrown-away one.
 */
function salvageStringArgs(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The cut can land inside an escape (`…aten\u00`, or a lone `\`). That fragment
  // is not text, and a trailing backslash also stops the field patterns matching.
  const text = raw.replace(DANGLING_ESCAPE, "");
  // A completed `"key": "value",` or `"key": "value"}` pair. Escaped quotes
  // inside the value are handled by the string pattern.
  const STRING_FIELD = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*[,}]/gs;
  let m: RegExpExecArray | null;
  let lastCompleteEnd = 0;
  while ((m = STRING_FIELD.exec(text)) !== null) {
    out[unescapeJson(m[1]!)] = unescapeJson(m[2]!);
    lastCompleteEnd = STRING_FIELD.lastIndex;
  }

  // The tail after the last complete field: if it opens one more string field
  // that never closed (the `done` summary cut mid-value), keep its content up
  // to the cut. A half-said answer beats a thrown-away one.
  const LONE_FIELD = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)$/s;
  const lone = LONE_FIELD.exec(text.slice(lastCompleteEnd));
  if (lone && lone[2]) {
    out[unescapeJson(lone[1]!)] = unescapeJson(lone[2]!);
  }
  return out;
}

/** Every escape JSON defines, matched whole so the pass can't re-read its output. */
const JSON_ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
/** What a cut leaves behind mid-escape: `\u00`, or a lone trailing `\`. */
const DANGLING_ESCAPE = /(?<!\\)\\(?:u[0-9a-fA-F]{0,3})?$/;

/**
 * Reverse the JSON string escapes a streamed value carries (\", \\, \n, \uXXXX).
 * One left-to-right pass, not a chain of replaces: chained, `\\` became `\` before
 * the `\n` and `\uXXXX` rules ran, so a literal `\\n` turned into a newline.
 */
function unescapeJson(s: string): string {
  return s.replace(JSON_ESCAPE, (_, esc: string) =>
    esc.startsWith("u")
      ? String.fromCharCode(parseInt(esc.slice(1), 16))
      : (SIMPLE_ESCAPES[esc] ?? esc),
  );
}

/**
 * POST an SSE request and yield each `data:` payload, trimmed. The whole
 * transport envelope lives here once: non-2xx reads the body, logs it, and
 * throws the ProviderError both adapters surface; a missing body throws too.
 * Adapters keep only their per-event mapping.
 */
export async function* streamSse(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Names the provider in the error envelope, and says how it authenticates. */
  provider: ProviderIdentity;
  signal: AbortSignal;
  /** Request metadata merged into the debug log (model, message/tool counts). */
  meta?: Record<string, unknown>;
}): AsyncGenerator<string> {
  const { url, headers, body, provider, signal, meta } = opts;
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
    // A stopped run rejects here too, and that is not a failure — let it pass
    // through untouched. Anything else that isn't a recognizable transport
    // rejection is a bug of ours and keeps the loud path.
    if (signal.aborted || !isTransportFailure(e)) throw e;
    // warn, not error: the user's wifi is not a defect in this extension, and
    // console.error is what feeds chrome://extensions' Errors page.
    log.warn(`no response from ${url}: ${e instanceof Error ? e.message : String(e)}`);
    throw networkError(provider, url);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const now = Date.now();
    // Headers are authoritative (Anthropic names the window); the body fills
    // gaps (ChatGPT's codex backend carries the reset only in the 429 body).
    const fromHeaders = parseRateLimitReset((name) => res.headers.get(name), now);
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
    const { message, kind } = providerErrorMessage(
      provider,
      res.status,
      text,
      res.statusText,
      reset,
      now,
    );
    // A classified failure (rate limit, quota, auth…) is an expected provider state
    // the chat already surfaces with its fix — warn keeps it off chrome://extensions'
    // Errors page, which console.error feeds. Only an unclassified shape belongs
    // there: it's the signal that a provider changed something we don't know yet.
    if (kind) {
      log.warn(`HTTP ${res.status} from ${url}: ${truncate(text)}`);
    } else {
      log.error(`HTTP ${res.status} from ${url}: ${truncate(text)}`);
    }
    throw new ProviderError(message, res.status, kind, reset.retryAfterMs);
  }

  if (!res.body) throw new Error(i18n.t("errors.noResponseBody"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        yield trimmed.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
