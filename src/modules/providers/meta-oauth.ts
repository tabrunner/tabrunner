import type { OAuthCredential } from "./types";
import { ProviderError } from "./types";
import type { DeviceEndpoint } from "./device-code";
import { accountFromToken, REFRESH_SKEW_MS, str } from "./oauth";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("meta-oauth");

/**
 * Meta Muse — a device sign-in with a second hop, like GitHub's.
 *
 * Meta splits identity from API access: the token the device flow issues
 * proves who you are and buys nothing. It is traded at the Muse key endpoint
 * for a Model API key, which lasts about a day, and trading it again IS the
 * refresh. So `refreshToken` holds the identity token and `accessToken` the
 * minted key.
 *
 * The identity token itself cannot be renewed — auth.meta.com issues no
 * refresh token and answers `grant_type=refresh_token` with a 404 — so when
 * the mint returns 401 or 403 the session is simply over, and the only way
 * back is a fresh sign-in. The credential seam already reads those two
 * statuses that way.
 */

/** The Muse Code CLI's client id — Meta issues no self-service one. */
const CLIENT_ID = "1031625952748946";

export const META_DEVICE: DeviceEndpoint = {
  clientId: CLIENT_ID,
  deviceUrl: "https://auth.meta.com/oidc/device/authorization/",
  tokenUrl: "https://auth.meta.com/oidc/device/token/",
  encode: "form",
};

const KEY_MINT_URL = "https://api.meta.ai/muse-code/key";

/** What a minted key is good for. Meta states it nowhere in the response. */
const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Trade the identity token for a Model API key. Both sign-in and refresh land
 * here — there is no other renewal.
 */
async function mintApiKey(identityToken: string): Promise<OAuthCredential> {
  const res = await fetch(KEY_MINT_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${identityToken}`,
      "x-api-version": "1.0.0",
    },
    body: "{}",
  });
  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (!res.ok) {
    throw new ProviderError(
      i18n.t("errors.signInFailed", {
        detail: str(record.error_description) ?? str(record.detail) ?? String(res.status),
      }),
      res.status,
    );
  }

  const apiKey = str(record.api_key);
  if (!apiKey) {
    // Meta answers 200 with no key when the account exists but Muse was never
    // set up on it — a dead end unless the message says where to go and what
    // to do after. `action_url` is Meta's own pointer at that page.
    const actionUrl = webUrl(str(record.action_url));
    throw new ProviderError(
      actionUrl ? i18n.t("errors.metaSetupAt", { url: actionUrl }) : i18n.t("errors.metaSetup"),
      0,
    );
  }

  log.info("muse key minted");
  return {
    accessToken: apiKey,
    refreshToken: identityToken,
    expiresAt: Date.now() + KEY_LIFETIME_MS - REFRESH_SKEW_MS,
  };
}

/** The sign-in half: the device poll's identity token, traded and named. */
export async function withAccount(body: Record<string, unknown>): Promise<OAuthCredential> {
  const identityToken = str(body.access_token);
  if (!identityToken) throw new ProviderError(i18n.t("errors.signInTokenResponse"), 0);

  const credential = await mintApiKey(identityToken);
  // The minted key is opaque; the identity token is the one with claims.
  const account = accountFromToken(identityToken, "email", "preferred_username", "sub");
  return account ? { ...credential, account } : credential;
}

/** Re-mint from the stored identity token, keeping the name already on screen. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const fresh = await mintApiKey(credential.refreshToken);
  return credential.account ? { ...fresh, account: credential.account } : fresh;
}

/** A URL we are willing to print — `action_url` arrives off the network. */
function webUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
