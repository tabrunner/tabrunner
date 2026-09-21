import type { OAuthCredential } from "./types";
import {
  accountFromToken,
  captureRedirect,
  generatePKCE,
  jwtClaims,
  postToken,
  randomState,
  str,
  toCredential,
} from "./oauth";
import { createLogger } from "@/lib/logger";

const log = createLogger("chatgpt-oauth");

/**
 * OpenAI's ChatGPT Codex OAuth surface, all of it. The client id is the one
 * the Codex CLI ships publicly and the redirect is its hardcoded localhost
 * callback — sign-in works without impersonating the CLI: we reuse its
 * registered client, run PKCE against auth.openai.com ourselves, and capture
 * the redirect with tabs.onUpdated because an MV3 service worker can't listen
 * on a socket (and there is nothing to listen for — the code rides the URL).
 * The scope's `api.connectors.*` grants are what unlock the subscription quota
 * the Codex backend bills against.
 *
 * ponytail: a vendor's public client id and a fixed redirect port. Ceiling —
 * if OpenAI rotates the client or rejects the redirect, sign-in breaks; this
 * file is then the only thing to fix.
 */
const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
} as const;

/** The authorize URL to open — exported so tests can pin the exact params. */
export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_OAUTH.clientId,
    redirect_uri: CHATGPT_OAUTH.redirectUri,
    scope: CHATGPT_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // The Codex CLI's own params — simplified flow hides the raw consent page
    // behind the subscription upsell, and the originator labels the app that
    // the tokens are being minted for.
    codex_cli_simplified_flow: "true",
    originator: "opencodex",
    id_token_add_organizations: "true",
  });
  return `${CHATGPT_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Full sign-in, start to finish: open the approval page, capture the localhost
 * redirect, exchange the code for tokens. `onPending` hands the UI the
 * authorize URL so it can offer a manual link if the tab never opened.
 */
export async function signInWithChatGPT(
  signal: AbortSignal,
  onPending?: (authorizeUrl: string) => void,
): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl(challenge, state);
  onPending?.(authorizeUrl);

  const code = await captureRedirect({
    authorizeUrl,
    redirectUri: CHATGPT_OAUTH.redirectUri,
    state,
    signal,
  });
  return exchangeCode(code, verifier);
}

/** Trade the authorization code for a token pair (form-urlencoded, per auth.openai.com). */
export async function exchangeCode(code: string, verifier: string): Promise<OAuthCredential> {
  const body = await postToken(
    CHATGPT_OAUTH.tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: CHATGPT_OAUTH.clientId,
      code,
      redirect_uri: CHATGPT_OAUTH.redirectUri,
      code_verifier: verifier,
    },
    { encode: "form" },
  );
  return withAccount(body);
}

/**
 * Trade a refresh token for a fresh pair. Both tokens rotate — persist both.
 * The new access token carries the same account claims, so the account id is
 * re-extracted; kept from the old credential as a fallback in case the refresh
 * response omits the id_token.
 */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = await postToken(
    CHATGPT_OAUTH.tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: CHATGPT_OAUTH.clientId,
      refresh_token: credential.refreshToken,
    },
    { encode: "form" },
  );
  log.info("token refreshed");
  return withAccount(body, credential.refreshToken, credential.chatgptAccountId);
}

/**
 * The credential a token response describes, named after the account it
 * belongs to and stamped with the account id the Codex backend demands.
 */
function withAccount(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
  fallbackAccountId?: string,
): OAuthCredential {
  const credential = toCredential(body, fallbackRefresh);
  // The id_token is the richer claim set; the access token covers refresh
  // responses that omit it.
  const idToken = str(body.id_token);
  const account =
    accountFromToken(idToken, "email") ?? accountFromToken(credential.accessToken, "email");
  const chatgptAccountId =
    chatgptAccountIdFromToken(idToken) ??
    chatgptAccountIdFromToken(credential.accessToken) ??
    fallbackAccountId;
  return {
    ...credential,
    ...(account ? { account } : {}),
    ...(chatgptAccountId ? { chatgptAccountId } : {}),
  };
}

/**
 * The ChatGPT account id a token belongs to — the `ChatGPT-Account-Id` header
 * the Codex backend requires. OpenAI names it `chatgpt_account_id` on the
 * token, nested under `https://api.openai.com/auth` on some token kinds, and
 * `organizations[0].id` on others — check all three.
 */
export function chatgptAccountIdFromToken(token?: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;

  const direct = str(claims.chatgpt_account_id);
  if (direct) return direct;

  const ns = claims["https://api.openai.com/auth"];
  if (typeof ns === "object" && ns !== null) {
    const nested = str((ns as Record<string, unknown>).chatgpt_account_id);
    if (nested) return nested;
  }

  const orgs = claims.organizations;
  if (Array.isArray(orgs)) {
    const first = orgs[0];
    if (typeof first === "object" && first !== null) {
      const id = str((first as Record<string, unknown>).id);
      if (id) return id;
    }
  }
  return undefined;
}
