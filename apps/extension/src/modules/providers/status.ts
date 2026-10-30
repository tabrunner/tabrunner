import type { ProviderConfig } from "./types";
import { PRESETS } from "./presets";
import { usesZenFreeAccess } from "./zen";

/**
 * Whether a provider can actually run a task. The list sorts and labels on
 * this, so "which of these works?" is answerable by scanning rather than by
 * opening each one.
 *
 * Deliberately two states, not three: a token past its expiry is NOT a
 * problem — the next run refreshes it silently — so surfacing "expired" for
 * that would alarm the user about the normal case. A refresh that fails for
 * good clears the credential (see credential.ts), which lands the row in
 * `missing` with a Sign in button — the one action that actually helps.
 */
export type CredentialStatus = "connected" | "missing";

/** Local endpoints (Ollama) need no credential — they are usable as they are. */
function needsNoCredential(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Whether this provider is a subscription: signed into, with no key to paste. */
export function isOAuthProvider(id: string): boolean {
  return PRESETS.find((p) => p.id === id)?.auth === "oauth";
}

/**
 * Whether the form offers a sign-in for this provider. A subscription always
 * does; a keyed row that can also be signed into (OpenRouter, OpenCode Zen)
 * does too, and its missing state should say "sign in" like a subscription's.
 */
export function canSignIn(id: string): boolean {
  const preset = PRESETS.find((p) => p.id === id);
  return preset?.auth === "oauth" || preset?.signIn !== undefined;
}

export function credentialStatus(provider: ProviderConfig): CredentialStatus {
  // A signed-in row is connected whatever kind of preset it is. A keyed row that
  // can also be signed into holds `auth` and an empty key, which the key check
  // below would call missing.
  if (provider.auth || usesZenFreeAccess(provider)) return "connected";
  if (isOAuthProvider(provider.id)) return "missing";
  return provider.apiKey || needsNoCredential(provider.baseUrl) ? "connected" : "missing";
}

/** Connected first, unconfigured last; original order kept within each group. */
export function byCredentialStatus(a: ProviderConfig, b: ProviderConfig): number {
  const rank = (p: ProviderConfig) => (credentialStatus(p) === "connected" ? 0 : 1);
  return rank(a) - rank(b);
}
