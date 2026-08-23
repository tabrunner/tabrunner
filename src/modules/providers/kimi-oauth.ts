import type { OAuthCredential } from "./types";
import { ProviderError, SignInError } from "./types";
import { jwtClaims, num, postToken, str, toCredential } from "./oauth";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("kimi-oauth");

/**
 * Kimi's OAuth surface, all of it. The client id is the one Kimi's own CLI
 * ships publicly; sign-in works without impersonating it (the CLI's X-Msh-*
 * identity headers are optional — verified against the live endpoint), so we
 * send none of them and authenticate as ourselves.
 *
 * ponytail: a vendor's public client id. Ceiling — if Kimi rotates it or adds
 * client attestation, sign-in breaks; this file is then the only thing to fix.
 */
const KIMI_OAUTH = {
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  deviceUrl: "https://auth.kimi.ai/api/oauth/device_authorization",
  tokenUrl: "https://auth.kimi.ai/api/oauth/token",
  deviceGrant: "urn:ietf:params:oauth:grant-type:device_code",
} as const;

/** RFC 8628: a `slow_down` response adds this to the poll interval. */
const SLOW_DOWN_STEP_MS = 5000;

/** What the user must do to finish signing in. */
export interface DevicePrompt {
  /** Shown verbatim — it must match what the page displays. */
  userCode: string;
  /** The approval page, user code pre-filled. */
  verificationUrl: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}

/** Step 1 — ask Kimi for a code the user can approve on the web. */
export async function requestDeviceCode(): Promise<DevicePrompt> {
  const body = await postToken(
    KIMI_OAUTH.deviceUrl,
    { client_id: KIMI_OAUTH.clientId },
    { encode: "form" },
  );
  const userCode = str(body.user_code);
  const deviceCode = str(body.device_code);
  const verificationUrl = str(body.verification_uri_complete) ?? str(body.verification_uri);
  if (!userCode || !deviceCode || !verificationUrl) {
    throw new ProviderError(i18n.t("errors.signInDeviceResponse"), 0);
  }
  const intervalSec = num(body.interval) ?? 5;
  const expiresSec = num(body.expires_in) ?? 900;
  log.info("device code issued", { expiresInSec: expiresSec });
  return {
    userCode,
    verificationUrl,
    deviceCode,
    intervalMs: Math.max(1000, intervalSec * 1000),
    expiresAt: Date.now() + expiresSec * 1000,
  };
}

/**
 * Step 2 — poll until the user approves. Resolves with the credential, or
 * throws SignInError so the caller can word each ending differently. The
 * signal is how a closed dialog stops the polling.
 */
export async function pollForToken(
  prompt: DevicePrompt,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  let waitMs = prompt.intervalMs;
  while (Date.now() < prompt.expiresAt) {
    await sleep(waitMs, signal);
    const body = await postToken(
      KIMI_OAUTH.tokenUrl,
      {
        client_id: KIMI_OAUTH.clientId,
        device_code: prompt.deviceCode,
        grant_type: KIMI_OAUTH.deviceGrant,
      },
      // Pending is the expected answer for most of this loop, not a failure.
      { encode: "form", allowErrorBody: true },
    );

    if (str(body.access_token)) return withAccount(body);

    switch (str(body.error)) {
      case "authorization_pending":
        break;
      case "slow_down":
        // The server may also hand back a longer interval — honour whichever is larger.
        waitMs = Math.max(waitMs + SLOW_DOWN_STEP_MS, (num(body.interval) ?? 0) * 1000);
        break;
      case "access_denied":
        throw new SignInError("denied");
      case "expired_token":
        throw new SignInError("expired");
      default:
        throw new ProviderError(
          i18n.t("errors.signInFailed", {
            detail: str(body.error_description) ?? str(body.error) ?? "",
          }),
          0,
        );
    }
  }
  throw new SignInError("expired");
}

/** Trade a refresh token for a fresh pair. Both tokens rotate — persist both. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = await postToken(
    KIMI_OAUTH.tokenUrl,
    {
      client_id: KIMI_OAUTH.clientId,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    },
    { encode: "form" },
  );
  log.info("token refreshed");
  return withAccount(body, credential.refreshToken);
}

/** The credential a token response describes, named after the account it belongs to. */
function withAccount(body: Record<string, unknown>, fallbackRefresh?: string): OAuthCredential {
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

/** Interruptible delay — a cancelled sign-in stops here, not one poll later. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SignInError("cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new SignInError("cancelled"));
      },
      { once: true },
    );
  });
}
