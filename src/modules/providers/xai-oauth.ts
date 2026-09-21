import type { OAuthCredential } from "./types";
import type { DeviceEndpoint } from "./device-code";
import { jwtClaims, num, postToken, str, toCredential } from "./oauth";
import { createLogger } from "@/lib/logger";

const log = createLogger("xai-oauth");

/**
 * xAI's OAuth surface, all of it — the sign-in behind a SuperGrok or X Premium
 * subscription. The client id is the one the Grok CLI ships publicly; the
 * device-code protocol itself lives in device-code.ts.
 *
 * `referrer` names us rather than impersonating the CLI: xAI reads it as
 * attribution, and there is nothing to gain by claiming to be someone else.
 *
 * ponytail: a vendor's public client id. Ceiling — if xAI rotates it or adds
 * client attestation, sign-in breaks; this file is then the only thing to fix.
 */
export const XAI_DEVICE: DeviceEndpoint = {
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  scope: "openid profile email offline_access grok-cli:access api:access",
  extra: { referrer: "tabrunner" },
  encode: "form",
};

/**
 * xAI omits `expires_in` on some token responses. An hour is what its own
 * tokens carry when it does send one, and the stored expiry only decides when
 * we pre-emptively refresh — a guess that is too short costs one extra
 * refresh, while no expiry at all would be a credential nothing ever renews.
 */
const DEFAULT_LIFETIME_SEC = 3600;

/** The credential a token response describes, named after the account it belongs to. */
export function withAccount(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
): OAuthCredential {
  const credential = toCredential(
    { ...body, expires_in: num(body.expires_in) ?? DEFAULT_LIFETIME_SEC },
    fallbackRefresh,
  );
  const account = accountFromToken(credential.accessToken);
  return account ? { ...credential, account } : credential;
}

/** Trade a refresh token for a fresh pair. xAI may omit the refresh token; keep the old one then. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = await postToken(
    XAI_DEVICE.tokenUrl,
    {
      client_id: XAI_DEVICE.clientId,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    },
    { encode: "form" },
  );
  log.info("token refreshed");
  return withAccount(body, credential.refreshToken);
}

/**
 * The account a token belongs to, for the UI to show. The `openid profile
 * email` scopes put the email on the token; the subject id is the fallback
 * for an account that has none.
 */
export function accountFromToken(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  return str(claims.email)?.toLowerCase() ?? str(claims.sub);
}
