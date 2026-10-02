import {
  createAuthFlow,
  type AuthFlow,
  type AuthFlowId,
  type AuthHost,
} from "@providerkit/core/auth";
import { ProviderError } from "@providerkit/core";
import { i18n } from "@/i18n";
import { claudeFlow } from "./claude-oauth";
import { appName, captureRedirect } from "./oauth";

export type { SignInPrompt } from "@providerkit/core/auth";

/** What the package asks of the browser: open a page, catch a redirect. */
const HOST: AuthHost = {
  get appName() {
    return appName();
  },
  openUrl: (url) => void chrome.tabs.create({ url }),
  captureRedirect,
};

/** The package's id for each preset it signs in; `claude` is ours, see below. */
const CORE_FLOW: Record<string, AuthFlowId> = {
  chatgpt: "chatgpt",
  "kimi-plan": "kimi-plan",
  "xai-plan": "grok",
  "github-copilot": "github-copilot",
  meta: "meta",
  // Not a subscription row — OpenRouter's sign-in mints an ordinary API key on
  // the user's own account. It sits on the keyed preset as a second way to get
  // that key, which is why `openrouter` has no `auth: "oauth"`.
  openrouter: "openrouter",
};

/**
 * A preset's sign-in and renewal, or undefined for one that has none. The sign-in
 * card and the credential seam both read it, so a provider can never be
 * signable but not refreshable.
 */
export function authFlowFor(presetId: string): AuthFlow | undefined {
  if (presetId === "claude") return claudeFlow(HOST);
  const id = CORE_FLOW[presetId];
  return id && createAuthFlow(id, HOST);
}

/**
 * What to tell the user about a sign-in that failed. The package's own
 * messages are English-only, so the ones with a fix get our translated copy;
 * a refusal's message already carries the server's reason.
 */
export function signInErrorMessage(e: unknown): string {
  if (!(e instanceof ProviderError)) return e instanceof Error ? e.message : String(e);
  if (e.code === "token_incomplete") return i18n.t("errors.signInTokenResponse");
  if (e.code === "device_response_invalid") return i18n.t("errors.signInDeviceResponse");
  if (e.code === "token_refused" && e.status === 429) return i18n.t("errors.signInRateLimited");
  return e.message;
}
