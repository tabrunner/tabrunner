import type { OAuthCredential } from "./types";
import { ProviderError } from "./types";
import { captureRedirect, generatePKCE, str } from "./oauth";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("openrouter-oauth");

/**
 * OpenRouter's PKCE sign-in — the one flow here that does not end in an access
 * token. OpenRouter exchanges the authorization code for an ordinary API key
 * on the user's own account, which never expires and which they can see and
 * revoke at openrouter.ai like any other.
 *
 * That is why OpenRouter keeps a single preset row instead of the two Claude
 * and Kimi get. Those two rows exist because a plan and a key spend different
 * quotas; here both paths land on the same key, on the same account, billed
 * from the same credits. Signing in is a way to OBTAIN the key without a trip
 * to the console — not a second way to pay.
 *
 * There is no client id: the callback URL is whatever we ask for, and PKCE is
 * the whole proof. We capture that callback with tabs.onUpdated like the other
 * redirect flows — nothing is listening on the port, and nothing needs to be.
 *
 * ponytail: a fixed redirect port. Ceiling — if something on the machine is
 * genuinely serving 54546, it sees the code first; the exchange then fails
 * and the user is told to start over, which is the right end for a code we
 * can no longer trust.
 */
const OPENROUTER_OAUTH = {
  authorizeUrl: "https://openrouter.ai/auth",
  keysUrl: "https://openrouter.ai/api/v1/auth/keys",
  redirectUri: "http://localhost:54546/callback",
} as const;

/**
 * A minted key does not expire, so nothing should ever try to renew it. Dated
 * far enough out that `ensureProviderCredential` always takes the "still
 * valid" branch and hands the key straight through.
 */
const NEVER = Number.MAX_SAFE_INTEGER;

/** The authorize URL to open — exported so tests can pin the exact params. */
export function buildAuthorizeUrl(challenge: string): string {
  const params = new URLSearchParams({
    callback_url: OPENROUTER_OAUTH.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${OPENROUTER_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Full sign-in: open the approval page, capture the callback, trade the code
 * for a key. `onPending` hands the UI the authorize URL so it can offer a
 * manual link if the tab never opened.
 *
 * No `state` — OpenRouter's authorize endpoint takes none, and captureRedirect
 * explains why that is sound for a callback only our own tab can deliver.
 */
export async function signInWithOpenRouter(
  signal: AbortSignal,
  onPending?: (authorizeUrl: string) => void,
): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePKCE();
  const authorizeUrl = buildAuthorizeUrl(challenge);
  onPending?.(authorizeUrl);

  const code = await captureRedirect({
    authorizeUrl,
    redirectUri: OPENROUTER_OAUTH.redirectUri,
    signal,
  });
  return exchangeCode(code, verifier);
}

/**
 * Trade the authorization code for an API key.
 *
 * Not `postToken`: that one reads a body for an OAuth token trio and words its
 * failures that way, and this endpoint answers with `{ key }`. The shapes have
 * nothing in common but the method.
 */
export async function exchangeCode(code: string, verifier: string): Promise<OAuthCredential> {
  const res = await fetch(OPENROUTER_OAUTH.keysUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });

  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const key = str(record.key);

  if (!key) {
    const detail = str(record.message) ?? str(record.error) ?? String(res.status);
    log.info("key exchange refused", { status: res.status });
    throw new ProviderError(i18n.t("errors.signInFailed", { detail }), res.status);
  }

  log.info("api key minted");
  return { accessToken: key, refreshToken: "", expiresAt: NEVER };
}

/**
 * Nothing to renew — the key outlives the session. Present because the flow
 * registry wants both halves, so a provider can never be signable but not
 * refreshable; if the key is ever revoked, the run's own 401 is what tells the
 * user, and signing in again mints a new one.
 */
export function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  return Promise.resolve(credential);
}
