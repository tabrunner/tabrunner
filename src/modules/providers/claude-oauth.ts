import type { OAuthCredential } from "./types";
import {
  accountFromToken,
  captureRedirect,
  generatePKCE,
  postToken,
  randomState,
  str,
  toCredential,
} from "./oauth";
import { createLogger } from "@/lib/logger";

const log = createLogger("claude-oauth");

/**
 * Anthropic's Claude Code OAuth surface, all of it. The client id is the one
 * the CLI ships publicly and the redirect is the CLI's hardcoded localhost
 * callback — sign-in works without impersonating the CLI: we reuse its
 * registered client, run PKCE against Claude.ai ourselves, and capture the
 * redirect with tabs.onUpdated because an MV3 service worker can't listen on a
 * socket (and there is nothing to listen for — the code rides the URL).
 *
 * ponytail: a vendor's public client id and a fixed redirect port. Ceiling —
 * if Anthropic rotates the client or rejects the redirect, sign-in breaks;
 * this file is then the only thing to fix.
 */
const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  // Both hosts terminate the same grant: the current CLIs post here, and
  // Anthropic's own Chrome extension posts to platform.claude.com/v1/oauth/token
  // from a service worker without trouble. We use the API host because that is
  // where the rest of our traffic goes. (An earlier comment here blamed a 429 on
  // platform.claude.com being bot-protected — the official extension disproves
  // that; the 429 was the token endpoint throttling repeated attempts.)
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  redirectUri: "http://localhost:54545/callback",
  // Only what a browser agent spends: inference, plus the profile claim that
  // names the signed-in account in the UI. The CLI also asks for
  // `org:create_api_key` — a scope that lets a token MINT a durable API key on
  // the user's org — and we would never call it, so asking for it would put a
  // standing liability in storage for nothing. Anthropic's own extension asks
  // for `user:profile user:inference user:chat`; we don't need chat either.
  scopes: "user:profile user:inference",
} as const;

/** The authorize URL to open — exported so tests can pin the exact params. */
export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true", // tells the login page to show the subscription upsell
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * Full sign-in, start to finish: open the approval page, capture the localhost
 * redirect, exchange the code for tokens. `onPending` hands the UI the
 * authorize URL so it can offer a manual link if the tab never opened.
 */
export async function signInWithClaude(
  signal: AbortSignal,
  onPending?: (authorizeUrl: string) => void,
): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePKCE();
  // Its own random value, never the PKCE verifier: the verifier is the secret
  // half of the exchange, and a state rides through the URL bar, browser
  // history, and any extension watching the tab. (Anthropic's own extension
  // sends a base64url state to this same endpoint, so the charset was never
  // what broke an earlier attempt — the cause of that "Invalid request format"
  // is still unknown, and hex simply avoids the question.)
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl(challenge, state);
  onPending?.(authorizeUrl);

  const code = await captureRedirect({
    authorizeUrl,
    redirectUri: CLAUDE_OAUTH.redirectUri,
    state,
    signal,
  });
  return exchangeCode(code, state, verifier);
}

/** Trade the authorization code for a token pair. */
export async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
): Promise<OAuthCredential> {
  const body = await postToken(
    CLAUDE_OAUTH.tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH.clientId,
      code,
      state,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      code_verifier: verifier,
    },
    { encode: "json" },
  );
  return withAccount(body);
}

/** Trade a refresh token for a fresh pair. Anthropic rotates the access token; keep the old refresh when it omits one. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = await postToken(
    CLAUDE_OAUTH.tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: CLAUDE_OAUTH.clientId,
      refresh_token: credential.refreshToken,
    },
    { encode: "json" },
  );
  log.info("token refreshed");
  return withAccount(body, credential.refreshToken);
}

/** The credential a token response describes, named after the account it belongs to. */
function withAccount(body: Record<string, unknown>, fallbackRefresh?: string): OAuthCredential {
  const credential = toCredential(body, fallbackRefresh);
  const account =
    accountFromResponse(body) ?? accountFromToken(credential.accessToken, "email", "sub");
  return account ? { ...credential, account } : credential;
}

/** The account the token response itself names, if any. */
function accountFromResponse(body: Record<string, unknown>): string | undefined {
  const account = body.account;
  if (typeof account !== "object" || account === null) return undefined;
  const record = account as Record<string, unknown>;
  return str(record.email_address)?.toLowerCase() ?? str(record.uuid);
}
