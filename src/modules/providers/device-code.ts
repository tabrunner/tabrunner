import { ProviderError, SignInError } from "./types";
import { num, postToken, str } from "./oauth";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("device-code");

/**
 * RFC 8628 device authorization — the sign-in shape that shows a code instead
 * of bouncing through a redirect. Kimi, GitHub Copilot, xAI and Meta all speak
 * it, and nothing about the protocol is vendor-specific, so all of it lives
 * here: what differs is the two endpoints, the client id, and how each vendor
 * turns the token body into a credential — which stays in the vendor's file.
 *
 * This is the easiest shape for an extension to host. There is no redirect to
 * capture and no port to pretend to listen on (`captureRedirect` in oauth.ts
 * covers the vendors that insist on one): the user reads a code off our card
 * and approves it on the vendor's page.
 */

/** RFC 8628: a `slow_down` response adds this to the poll interval. */
const SLOW_DOWN_STEP_MS = 5000;

/** Device codes are short-lived; a vendor that omits `expires_in` gets this. */
const DEFAULT_EXPIRES_SEC = 900;

/** Where a vendor's device flow lives, and what it wants on the wire. */
export interface DeviceEndpoint {
  /** POST here to get a user code. */
  deviceUrl: string;
  /** POST here, repeatedly, until the user approves. */
  tokenUrl: string;
  clientId: string;
  /** Sent on the device-authorization request when the vendor wants scopes. */
  scope?: string;
  /**
   * Extra fields on the device-authorization POST — xAI wants a `referrer`.
   * Never applied to the poll, which RFC 8628 fixes to three fields.
   */
  extra?: Record<string, string>;
  /** Body encoding. Every vendor we speak to so far takes form; Kimi included. */
  encode: "form" | "json";
}

/** What the user must do, and how long we keep asking. */
export interface DevicePrompt {
  /** Shown verbatim — it must match what the vendor's page displays. */
  userCode: string;
  /** The approval page, user code pre-filled when the vendor offers that. */
  verificationUrl: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}

/**
 * Step 1 — ask the vendor for a code the user can approve on the web.
 *
 * The verification URL is opened in a tab, so it is checked to be http(s)
 * before we hand it to `chrome.tabs.create`: it arrives from the network, and
 * a `javascript:` or `data:` URL in that field would be a sign-in response
 * choosing what code runs in the user's browser.
 */
export async function requestDeviceCode(endpoint: DeviceEndpoint): Promise<DevicePrompt> {
  const body = await postToken(
    endpoint.deviceUrl,
    {
      client_id: endpoint.clientId,
      ...(endpoint.scope ? { scope: endpoint.scope } : {}),
      ...endpoint.extra,
    },
    { encode: endpoint.encode },
  );

  const userCode = str(body.user_code);
  const deviceCode = str(body.device_code);
  // `verification_uri_complete` carries the code in the URL — one less thing
  // for the user to type, so prefer it wherever the vendor sends one.
  const verificationUrl =
    webUrl(str(body.verification_uri_complete)) ?? webUrl(str(body.verification_uri));
  if (!userCode || !deviceCode || !verificationUrl) {
    throw new ProviderError(i18n.t("errors.signInDeviceResponse"), 0);
  }

  const intervalSec = num(body.interval) ?? 5;
  const expiresSec = num(body.expires_in) ?? DEFAULT_EXPIRES_SEC;
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
 * Step 2 — poll until the user approves, and hand back the raw token body.
 *
 * Building a credential out of it is the caller's job: the bodies genuinely
 * differ (GitHub answers with a bare `access_token` and no expiry at all,
 * Kimi with a full pair, Meta with an identity token that still has to be
 * traded for an API key), and a shared shim over that would hide more than it
 * saves. Throws `SignInError` so each ending can be worded differently.
 */
export async function pollDeviceToken(
  endpoint: DeviceEndpoint,
  prompt: DevicePrompt,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let waitMs = prompt.intervalMs;
  while (Date.now() < prompt.expiresAt) {
    await sleep(waitMs, signal);
    const body = await postToken(
      endpoint.tokenUrl,
      {
        client_id: endpoint.clientId,
        device_code: prompt.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      // Pending is the expected answer for most of this loop, not a failure.
      // GitHub even answers 200 with an `error` body, so the error branch
      // below is what decides — never the status.
      { encode: endpoint.encode, allowErrorBody: true },
    );

    if (str(body.access_token)) return body;

    switch (str(body.error)) {
      case "authorization_pending":
        break;
      case "slow_down":
        // The server may also hand back a longer interval — honour whichever is larger.
        waitMs = Math.max(waitMs + SLOW_DOWN_STEP_MS, (num(body.interval) ?? 0) * 1000);
        break;
      case "access_denied":
      case "authorization_denied":
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

/**
 * The URL if it is one we are willing to open, else undefined. Only http(s) —
 * this value comes off the network and ends up in `chrome.tabs.create`.
 */
function webUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
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
