import type { ProviderConfig } from "./types";
import { ProviderError } from "./types";
import { isTransportFailure, ProviderError as CoreProviderError } from "@providerkit/core";
import { tokenSource, type TokenSource } from "@providerkit/core/auth";
import { networkError } from "./http";
import { authFlowFor } from "./oauth-flows";
import { getProvider, saveProvider } from "./storage";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("credential");

/**
 * One token source per provider id, so a run start and a model listing that
 * fire together share one refresh. Both would otherwise spend the same refresh
 * token, and since these providers rotate it on use, the loser's is already dead.
 */
const sources = new Map<string, TokenSource>();

function sourceFor(id: string): TokenSource | undefined {
  const cached = sources.get(id);
  if (cached) return cached;
  const flow = authFlowFor(id);
  if (!flow) return undefined;
  const source = tokenSource({
    // Read from storage on every call: a cached copy would spend a refresh
    // token that has already rotated.
    load: async () => (await getProvider(id))?.auth,
    // Persist before use: the old refresh token is spent, so losing the new
    // pair here would strand the user at a forced sign-in.
    save: async (auth) => {
      const stored = await getProvider(id);
      if (stored) await saveProvider({ ...stored, auth });
    },
    refresh: flow.refresh,
  });
  sources.set(id, source);
  return source;
}

/**
 * A config ready to send: for key-based providers, itself; for OAuth ones, a
 * copy whose `apiKey` is a fresh access token — and whose `baseUrl` is the one
 * that token is good for, when the vendor pins one per account. Everything
 * downstream keeps reading `apiKey` and `baseUrl` and never learns the
 * difference. The adapters call this per request, so a token that expires
 * mid-run is renewed on the next turn.
 */
export async function ensureProviderCredential<C extends ProviderConfig>(config: C): Promise<C> {
  if (!config.auth) return config;
  try {
    const source = sourceFor(config.id);
    // A preset marked `auth` with no registered flow is a wiring bug; it takes
    // the same "sign in again" recovery as an expired token.
    if (!source) throw new ProviderError("No sign-in flow", 401, "auth");
    const auth = await source.getToken();
    return {
      ...config,
      auth,
      apiKey: auth.accessToken,
      ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
    };
  } catch (e) {
    log.warn("refresh failed:", e instanceof Error ? e.message : String(e));
    // A refresh that never reached the server says nothing about the
    // credential. "Sign in again" would send a user with dropped wifi to fix
    // a sign-in that is fine — and the run retries a network failure on its
    // own, which it would not do for a dead token.
    if (isTransportFailure(e)) throw networkError(config);
    // A rejected refresh token is dead for good — drop it so the list shows
    // "Not signed in" with a Sign in button instead of pretending it works.
    // Anything else — a reply we couldn't read — leaves the credential alone
    // to retry later.
    if (e instanceof CoreProviderError && e.code === "refresh_dead") {
      const stored = await getProvider(config.id);
      if (stored) {
        delete stored.auth;
        await saveProvider(stored);
      }
    }
    throw new ProviderError(
      i18n.t("errors.oauthRefreshExpired", { name: config.name }),
      401,
      "auth",
    );
  }
}
