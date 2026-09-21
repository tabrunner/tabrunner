import type { OAuthCredential } from "./types";
import { ProviderError } from "./types";
import type { DeviceEndpoint } from "./device-code";
import { num, REFRESH_SKEW_MS, str } from "./oauth";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("github-oauth");

/**
 * GitHub Copilot — a device sign-in with a second hop.
 *
 * GitHub's device flow ends in a long-lived GitHub token, which the Copilot
 * API does not accept. That token is traded at `copilot_internal/v2/token` for
 * a short-lived Copilot token (~25 minutes), and trading it again IS the
 * refresh. So the two credential slots hold two things that are not an OAuth
 * pair: `refreshToken` is the GitHub token, `accessToken` the Copilot one.
 *
 * ponytail: github.com only — a GitHub Enterprise Server tenant serves the
 * same three endpoints under its own domain. Making that work is threading one
 * user-typed domain through these constants; the ceiling is that an Enterprise
 * user sees a failed sign-in instead of a domain field.
 */

/**
 * ponytail: this is VS Code's own Copilot Chat client id, not ours. GitHub
 * issues no self-service Copilot client id, so every third-party client that
 * speaks this API uses it — the consent page therefore says "GitHub Copilot
 * Chat" rather than "TabRunner", which is a real thing to fix and not a thing
 * we can fix from here. Upgrade path: register a TabRunner OAuth app with
 * GitHub, swap this one constant.
 */
const CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const GITHUB_DEVICE: DeviceEndpoint = {
  clientId: CLIENT_ID,
  deviceUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  // Only enough to read the account name for the signed-in card. Copilot
  // itself is entitled by the account, not by a scope.
  scope: "read:user",
  encode: "form",
};

/** Where the GitHub token becomes a Copilot token. */
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
/** Whose login names the connected account. */
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * What an individual seat is served from. Every other plan gets its own host,
 * which the minted token names — this is only the answer when it doesn't.
 */
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

/**
 * The editor fingerprint Copilot's gate wants on every call, ours and honest —
 * the integration id is the one borrowed value, because it names a VS Code
 * integration GitHub allowlists and there is no TabRunner one to name.
 *
 * `turn` is the whole reason this is a function. GitHub bills one premium
 * request per user-initiated turn and lets the agent's own follow-ups inside
 * that turn ride free, and `X-Initiator` is how a client declares which it is.
 * Leaving it off means every tool call in a run bills as a fresh turn — a task
 * that takes thirty steps would spend thirty of the user's 300 monthly
 * requests instead of one.
 *
 * `User-Agent` is deliberately absent: a browser refuses to set it, Chrome
 * sends its own, and the gate reads the Editor-* pair rather than that.
 */
export function copilotHeaders(turn: "user" | "agent"): Record<string, string> {
  const version = `TabRunner/${chrome.runtime.getManifest().version}`;
  return {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": version,
    "Editor-Plugin-Version": version,
    "X-GitHub-Api-Version": "2026-06-01",
    "Openai-Intent": "conversation-edits",
    // A capability declaration, not a claim about this body: TabRunner sends
    // screenshots constantly, and a request that omits it has its images
    // dropped. Harmless on the text-only turns.
    "Copilot-Vision-Request": "true",
    "X-Initiator": turn,
  };
}

/**
 * Trade a GitHub token for a Copilot one. Both sign-in and refresh land here —
 * there is no other renewal, so a revoked GitHub token surfaces as this call's
 * 401 and the credential seam turns it into "sign in again".
 */
async function mintCopilotToken(githubToken: string): Promise<OAuthCredential> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...copilotHeaders("user"),
    },
  });
  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (!res.ok) {
    throw new ProviderError(
      i18n.t("errors.signInFailed", { detail: str(record.message) ?? String(res.status) }),
      res.status,
    );
  }

  const accessToken = str(record.token);
  // Absolute epoch SECONDS here, not the `expires_in` every other vendor sends.
  const expiresAtSec = num(record.expires_at);
  if (!accessToken || expiresAtSec === undefined) {
    throw new ProviderError(i18n.t("errors.signInTokenResponse"), 0);
  }

  const baseUrl = apiHost(record.endpoints) ?? hostFromToken(accessToken) ?? DEFAULT_BASE_URL;
  log.info("copilot token minted", { baseUrl });
  return {
    accessToken,
    refreshToken: githubToken,
    expiresAt: expiresAtSec * 1000 - REFRESH_SKEW_MS,
    baseUrl,
  };
}

/** The sign-in half: the device poll's GitHub token, traded and named. */
export async function withAccount(body: Record<string, unknown>): Promise<OAuthCredential> {
  const githubToken = str(body.access_token);
  if (!githubToken) throw new ProviderError(i18n.t("errors.signInTokenResponse"), 0);

  const credential = await mintCopilotToken(githubToken);
  const account = await githubLogin(githubToken);
  return account ? { ...credential, account } : credential;
}

/** Re-mint from the stored GitHub token, keeping the name the card already shows. */
export async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const fresh = await mintCopilotToken(credential.refreshToken);
  return credential.account ? { ...fresh, account: credential.account } : fresh;
}

/**
 * The account's login, for the connected card. Best-effort on purpose — a
 * sign-in that worked must not fail because the name lookup didn't; the card
 * just says "Signed in" instead.
 */
async function githubLogin(githubToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GITHUB_USER_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}` },
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null
      ? str((body as Record<string, unknown>).login)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The endpoint map a current token response carries — the vendor saying it outright. */
function apiHost(endpoints: unknown): string | undefined {
  if (typeof endpoints !== "object" || endpoints === null) return undefined;
  const api = str((endpoints as Record<string, unknown>).api);
  return api && api.startsWith("https://") ? api : undefined;
}

/**
 * The same answer read off the token itself, for a response that ships no
 * endpoint map. A Copilot token is a `;`-joined field list carrying
 * `proxy-ep=proxy.<plan>.githubcopilot.com`, and the API host is that with
 * `proxy.` swapped for `api.`.
 */
function hostFromToken(token: string): string | undefined {
  const proxy = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
  return proxy ? `https://${proxy.replace(/^proxy\./, "api.")}` : undefined;
}
