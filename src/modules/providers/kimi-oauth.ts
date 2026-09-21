import type { OAuthCredential } from "./types";
import type { DeviceEndpoint } from "./device-code";
import { jwtClaims, postToken, str, toCredential } from "./oauth";
import { createLogger } from "@/lib/logger";

const log = createLogger("kimi-oauth");

/**
 * Kimi's OAuth surface, all of it. The client id is the one Kimi's own CLI
 * ships publicly; sign-in works without impersonating it (the CLI's X-Msh-*
 * identity headers are optional — verified against the live endpoint), so we
 * send none of them and authenticate as ourselves.
 *
 * The device-code protocol itself lives in device-code.ts — what is Kimi's own
 * is the pair of endpoints below and which claim names the account.
 *
 * ponytail: a vendor's public client id. Ceiling — if Kimi rotates it or adds
 * client attestation, sign-in breaks; this file is then the only thing to fix.
 */
export const KIMI_DEVICE: DeviceEndpoint = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  deviceUrl: "https://auth.kimi.ai/api/oauth/device_authorization",
  tokenUrl: "https://auth.kimi.ai/api/oauth/token",
  encode: "form",
};

/** Trade a refresh token for a fresh pair. Both tokens rotate — persist both. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = await postToken(
    KIMI_DEVICE.tokenUrl,
    {
      client_id: KIMI_DEVICE.clientId,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    },
    { encode: "form" },
  );
  log.info("token refreshed");
  return withAccount(body, credential.refreshToken);
}

/** The credential a token response describes, named after the account it belongs to. */
export function withAccount(
  body: Record<string, unknown>,
  fallbackRefresh?: string,
): OAuthCredential {
  const credential = toCredential(body, fallbackRefresh);
  const account = accountFromToken(credential.accessToken);
  return account ? { ...credential, account } : credential;
}

/**
 * The account a token belongs to, for the UI to show. Kimi issues JWTs whose
 * claims carry the email, then a user id, then the subject.
 */
export function accountFromToken(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  return str(claims.email)?.toLowerCase() ?? str(claims.user_id) ?? str(claims.sub);
}
