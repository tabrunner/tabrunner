import type { OAuthCredential } from "./types";
import type { DeviceEndpoint } from "./device-code";
import { pollDeviceToken, requestDeviceCode } from "./device-code";
import { refreshCredential as refreshClaude, signInWithClaude } from "./claude-oauth";
import { refreshCredential as refreshChatGPT, signInWithChatGPT } from "./chatgpt-oauth";
import {
  KIMI_DEVICE,
  refreshCredential as refreshKimi,
  withAccount as kimiCredential,
} from "./kimi-oauth";
import {
  XAI_DEVICE,
  refreshCredential as refreshXai,
  withAccount as xaiCredential,
} from "./xai-oauth";
import { refreshCredential as refreshOpenRouter, signInWithOpenRouter } from "./openrouter-oauth";

/** What the user must do on the vendor's page to finish signing in. */
export interface SignInPrompt {
  /** The approval page — opened in a tab, and offered as a link if that was blocked. */
  url: string;
  /** Device-code flows only: the code that page asks for. */
  userCode?: string;
}

/** A signed-in provider's two operations — sign in once, then renew forever. */
export interface OAuthFlow {
  signIn: (
    signal: AbortSignal,
    onPrompt: (prompt: SignInPrompt) => void,
  ) => Promise<OAuthCredential>;
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>;
}

/**
 * A device-code sign-in, start to finish: ask for the code, show it, open the
 * approval page, poll until the user approves. The protocol is in
 * device-code.ts; `toCredential` is the only vendor-specific half, and it earns
 * being a hook — GitHub and Meta both have another hop after the poll before
 * there is anything a request can carry.
 */
function deviceSignIn(
  endpoint: DeviceEndpoint,
  toCredential: (body: Record<string, unknown>) => OAuthCredential | Promise<OAuthCredential>,
): OAuthFlow["signIn"] {
  return async (signal, onPrompt) => {
    const prompt = await requestDeviceCode(endpoint);
    onPrompt({ url: prompt.verificationUrl, userCode: prompt.userCode });
    // The approval page, opened for them. If the browser blocks it, the code
    // stays on screen as the fallback — that's why it's shown while we wait.
    void chrome.tabs.create({ url: prompt.verificationUrl });
    return toCredential(await pollDeviceToken(endpoint, prompt, signal));
  };
}

/**
 * Every OAuth preset's flow, keyed by preset id. One registry, read by both the
 * sign-in card and the credential seam, so a provider can never be half-wired —
 * signable but not refreshable, or the reverse. Adding one is a single entry
 * here plus its `auth: "oauth"` preset.
 *
 * The vendor differences end up being exactly two: how the approval page is
 * reached, and whether it also shows a code.
 */
export const OAUTH_FLOWS: Record<string, OAuthFlow> = {
  claude: {
    signIn: (signal, onPrompt) => signInWithClaude(signal, (url) => onPrompt({ url })),
    refresh: refreshClaude,
  },
  chatgpt: {
    signIn: (signal, onPrompt) => signInWithChatGPT(signal, (url) => onPrompt({ url })),
    refresh: refreshChatGPT,
  },
  "kimi-plan": {
    signIn: deviceSignIn(KIMI_DEVICE, (body) => kimiCredential(body)),
    refresh: refreshKimi,
  },
  "xai-plan": {
    signIn: deviceSignIn(XAI_DEVICE, (body) => xaiCredential(body)),
    refresh: refreshXai,
  },
  // Not a subscription row — OpenRouter's sign-in mints an ordinary API key on
  // the user's own account. It sits on the keyed preset as a second way to get
  // that key, which is why `openrouter` has no `auth: "oauth"`.
  openrouter: {
    signIn: (signal, onPrompt) => signInWithOpenRouter(signal, (url) => onPrompt({ url })),
    refresh: refreshOpenRouter,
  },
};
