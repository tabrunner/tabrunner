import type { OAuthCredential } from "./types";
import { ProviderError, SignInError } from "./types";
import { createLogger, truncate } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("oauth");

/**
 * The OAuth plumbing every signed-in provider shares: PKCE, the localhost
 * redirect capture, the token POST, and the credential it builds. What stays
 * in the per-vendor files is only what genuinely differs — client ids,
 * authorize params, and which claim names the account.
 */

/**
 * Refresh this long before the server's stated expiry. Baked into the stored
 * `expiresAt` so every reader gets the margin for free.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** An authorization code is only good for a few minutes — stop waiting past that. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Close a tab we opened, tolerating one that is already gone. Every exit runs
 * the same cleanup, and a tab's lifetime is not ours to assume: the window can
 * close under it, or the browser can be shutting down. `tabs.remove` on a dead
 * id rejects with "No tab with id", so an unguarded call surfaces as an
 * uncaught rejection — noise from what is really a completed cancel.
 */
function closeTab(tabId?: number): void {
  if (tabId === undefined) return;
  void chrome.tabs.remove(tabId).catch(() => {});
}

/** RFC 7636 code verifier + S256 challenge, browser-safe (no Node Buffer). */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(64);
  crypto.getRandomValues(verifierBytes);
  const verifier = toBase64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

/**
 * Opaque CSRF state — 128 bits, hex. The charset is not load-bearing (vendors
 * accept base64url here, Anthropic's own extension sends it); hex is just the
 * form with no reserved characters to think about.
 */
export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Open the approval page and wait for the browser to redirect it to our
 * localhost callback, then read the code off the URL. There's no server behind
 * that port — the tab is about to show a connection error — so the code is
 * grabbed the moment the navigation starts and the tab is closed before that
 * page renders. The tab is closed on every exit: success, failure, or cancel.
 */
export function captureRedirect(opts: {
  authorizeUrl: string;
  redirectUri: string;
  /**
   * The CSRF value we issued, when the vendor round-trips one. Omitted for a
   * vendor that takes no `state` at all (OpenRouter) — and safe to omit here
   * in a way it would not be on a server, because this callback is not a
   * public endpoint: the answer is only read off the ONE tab we opened, whose
   * id we hold, and PKCE still binds the code to a verifier that never left
   * this worker. A forged code would have to arrive inside our own tab and
   * would still fail the exchange.
   */
  state?: string;
  signal: AbortSignal;
}): Promise<string> {
  const { origin: callbackOrigin, pathname: callbackPath } = new URL(opts.redirectUri);
  const { authorizeUrl, state, signal } = opts;

  return new Promise((resolve, reject) => {
    let openedTabId: number | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      closeTab(openedTabId);
    };

    const onAbort = () => finish(() => reject(new SignInError("cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(
      () => finish(() => reject(new SignInError("expired"))),
      CALLBACK_TIMEOUT_MS,
    );

    // The installed @types/chrome is a partial stub without TabChangeInfo —
    // derive the listener signature from the API it attaches to instead.
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      tabId,
      changeInfo,
    ) => {
      if (tabId !== openedTabId || !changeInfo.url) return;
      // The approval page bounces vendor → consent → localhost callback; only
      // the final hop onto our redirect matters.
      if (!changeInfo.url.startsWith(callbackOrigin)) return;
      const url = new URL(changeInfo.url);
      if (url.pathname !== callbackPath) return;

      // CSRF guard: when we issued a state, the callback must carry it back.
      if (
        (state !== undefined && url.searchParams.get("state") !== state) ||
        url.searchParams.get("error")
      ) {
        finish(() => reject(new SignInError("denied")));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        finish(() => reject(new SignInError("denied")));
        return;
      }
      finish(() => resolve(code));
    };

    // The user closing the approve tab is a cancel, not a five-minute wait.
    // Forget the id first: the tab is already gone, so the cleanup that follows
    // must not ask Chrome to close it again.
    const onRemoved: Parameters<typeof chrome.tabs.onRemoved.addListener>[0] = (tabId) => {
      if (tabId !== openedTabId) return;
      openedTabId = undefined;
      finish(() => reject(new SignInError("cancelled")));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    void chrome.tabs.create({ url: authorizeUrl }).then(
      (tab) => {
        if (settled) {
          // The tab created is ours, so its id is set — but the type keeps it
          // optional, and removing an id-less tab would be a no-op anyway.
          closeTab(tab.id);
          return;
        }
        openedTabId = tab.id;
      },
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

/**
 * POST to a token endpoint and hand back the parsed body.
 *
 * Tokens — not the status code — decide whether a sign-in worked: a vendor can
 * return a usable credential alongside a non-2xx (Anthropic answers 429 for a
 * plan over its usage limit). Any body carrying a full pair is a success;
 * only a body without one is an error.
 */
export async function postToken(
  url: string,
  params: Record<string, string>,
  opts: { encode: "json" | "form"; allowErrorBody?: boolean },
): Promise<Record<string, unknown>> {
  const json = opts.encode === "json";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });

  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (isCredentialBody(record)) return record;
  // The device-flow poll answers 4xx while the user is still deciding, so that
  // caller reads those bodies instead of treating them as transport failures.
  if (res.ok || (opts.allowErrorBody && res.status < 500)) return record;

  const detail = errorDetail(record);
  log.info("token request refused", { status: res.status, detail: detail ? truncate(detail) : "" });
  throw new ProviderError(rejectionMessage(res, detail), res.status);
}

/**
 * What to tell the user about a token endpoint that refused.
 *
 * A 429 here is the SIGN-IN service throttling the request — it says nothing
 * about the account's usage, so it must never claim the plan is spent (an
 * untouched plan being blamed is worse than no explanation). `Retry-After`
 * turns "wait a bit" into an actual number whenever the vendor sends one.
 */
function rejectionMessage(res: Response, detail?: string): string {
  if (res.status !== 429) {
    return i18n.t("errors.signInFailed", { detail: detail ?? String(res.status) });
  }
  const seconds = num(Number(res.headers.get("retry-after")));
  return seconds && seconds > 0
    ? i18n.t("errors.signInRateLimitedFor", { seconds: Math.ceil(seconds) })
    : i18n.t("errors.signInRateLimited");
}

/** Whether the body holds a full token pair — the sign of a successful exchange. */
function isCredentialBody(body: Record<string, unknown>): boolean {
  return (
    str(body.access_token) !== undefined &&
    str(body.refresh_token) !== undefined &&
    num(body.expires_in) !== undefined
  );
}

/**
 * Pull a human reason out of an OAuth error body — RFC 6749 (`error` /
 * `error_description`) or a nested object (`error.message` / `error.type`),
 * which Anthropic and OpenAI both use.
 */
function errorDetail(record: Record<string, unknown>): string | undefined {
  const description = str(record.error_description);
  if (description) return description;
  const error = record.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const nested = error as Record<string, unknown>;
    return str(nested.message) ?? str(nested.type);
  }
  return undefined;
}

/**
 * The stored credential a token response describes. Naming the account is the
 * caller's job — every vendor puts it under a different claim.
 */
export function toCredential(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
): OAuthCredential {
  const accessToken = str(body.access_token);
  // A refresh response may omit the refresh token; keeping the old one is correct then.
  const refreshToken = str(body.refresh_token) ?? fallbackRefresh;
  const expiresIn = num(body.expires_in);
  if (!accessToken || !refreshToken || expiresIn === undefined) {
    throw new ProviderError(i18n.t("errors.signInTokenResponse"), 0);
  }
  return {
    accessToken,
    refreshToken,
    // Skew baked in — readers compare against now() with no margin of their own.
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
  };
}

/**
 * A JWT's payload, read WITHOUT verifying the signature — fine here because
 * nothing is authorized on it: it only decides what name the UI prints.
 */
export function jwtClaims(token?: string): Record<string, unknown> | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    // Not a JWT, or not one we understand — the row just says "Signed in".
    return undefined;
  }
}

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
