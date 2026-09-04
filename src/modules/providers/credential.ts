import type { ProviderConfig } from "./types";
import { ProviderError } from "./types";
import { isTransportFailure } from "@providerkit/core";
import { networkError } from "./http";
import { OAUTH_FLOWS } from "./oauth-flows";
import { saveProvider } from "./storage";
import { createLogger } from "@/lib/logger";
import { i18n } from "@/i18n";

const log = createLogger("credential");

/**
 * In-flight refreshes, keyed by provider id. A run start and a model listing
 * can fire together; without this they would both spend the same refresh
 * token, and since these providers rotate it on use, the loser's token is
 * already dead.
 */
const refreshing = new Map<string, Promise<ProviderConfig>>();

/**
 * A config ready to send: for key-based providers, itself; for OAuth ones, a
 * copy whose `apiKey` is a fresh access token. Everything downstream —
 * adapters, model listing — keeps reading `apiKey` and never learns the
 * difference.
 */
export async function ensureProviderCredential(config: ProviderConfig): Promise<ProviderConfig> {
  if (!config.auth) return config;
  if (Date.now() < config.auth.expiresAt) return withBearer(config, config.auth.accessToken);

  const inFlight = refreshing.get(config.id);
  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      const flow = OAUTH_FLOWS[config.id];
      if (!flow) {
        // A preset marked `auth` with no registered flow is a wiring bug; route
        // it through the same "sign in again" recovery as an expired token.
        throw new ProviderError(
          i18n.t("errors.oauthRefreshExpired", { name: config.name }),
          401,
          "auth",
        );
      }
      const refreshed = await flow.refresh(config.auth!);
      // Persist before use: the old refresh token is spent, so losing the new
      // pair here would strand the user at a forced sign-in.
      await saveProvider({ ...config, auth: refreshed });
      return withBearer({ ...config, auth: refreshed }, refreshed.accessToken);
    } catch (e) {
      const status = e instanceof ProviderError ? e.status : 0;
      log.warn("refresh failed:", e instanceof Error ? e.message : String(e));
      // A refresh that never reached the server says nothing about the
      // credential. "Sign in again" would send a user with dropped wifi to fix
      // a sign-in that is fine — and the run retries a network failure on its
      // own, which it would not do for a dead token.
      if (isTransportFailure(e)) throw networkError(config);
      // A rejected refresh token is dead for good — drop it so the list shows
      // "Not signed in" with a Sign in button instead of pretending it works.
      // Anything else with no status — a reply we couldn't read — leaves the
      // credential alone to retry later.
      if (status === 400 || status === 401 || status === 403) {
        const cleared = { ...config };
        delete cleared.auth;
        await saveProvider(cleared);
      }
      throw new ProviderError(
        i18n.t("errors.oauthRefreshExpired", { name: config.name }),
        401,
        "auth",
      );
    } finally {
      refreshing.delete(config.id);
    }
  })();

  refreshing.set(config.id, task);
  return task;
}

const withBearer = (config: ProviderConfig, accessToken: string): ProviderConfig => ({
  ...config,
  apiKey: accessToken,
});
