import type { ModelRate } from "@providerkit/core";
import { createJevClient } from "@providerkit/core/jev";
import type { JevClient, JevConfig, JevHost } from "@providerkit/core/jev";

/**
 * TabRunner's side of the four Jev hosts. The wire — URLs, envelopes, answer
 * checks, retries — is `@providerkit/core/jev`; what stays here is what the
 * package can't know: how the hosts are named and linked in Settings, the
 * price we bill at, and OpenRouter's balance.
 */

/** In the order the settings picker lists them. */
export const JEV_HOST_IDS = [
  "typesafe",
  "openrouter",
  "cloudflare",
  "vercel",
] as const satisfies readonly JevHost[];

/** What a saved Jev setup needs to reach its host. */
export type JevConnection = Pick<JevConfig, "host" | "apiKey" | "accountId">;

/** TypeSafe's list price, US$ per million tokens: input only, output is free.
 *  OpenRouter's own bill wins over it (`costUsd`). */
export const JEV_RATE: ModelRate = { input: 0.042, output: 0, cacheRead: 0 };

interface HostInfo {
  /** Brand name — never translated. */
  label: string;
  /** Where to get a key. */
  keyUrl: string;
  /** Where the host shows spend and balance. */
  usageUrl: string;
}

export const JEV_HOSTS: Record<JevHost, HostInfo> = {
  typesafe: {
    label: "TypeSafe",
    keyUrl: "https://console.typesafe.ai/settings/keys",
    usageUrl: "https://console.typesafe.ai",
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    usageUrl: "https://openrouter.ai/activity",
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    usageUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
  },
  vercel: {
    label: "Vercel AI Gateway",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys",
    usageUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai",
  },
};

/** The client for a saved setup. OpenRouter gets the same app attribution the
 *  chat preset sends; the other hosts ignore it. */
export function jevClient(conn: JevConnection): JevClient {
  return createJevClient({
    ...conn,
    attribution: { siteUrl: "https://tabrunner.app", siteName: "TabRunner" },
  });
}

/** OpenRouter's remaining balance in US$ — the one host that reports one. */
export async function openRouterBalance(apiKey: string): Promise<number | undefined> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    };
    const { total_credits: total, total_usage: used } = json.data ?? {};
    return typeof total === "number" && typeof used === "number" ? total - used : undefined;
  } catch {
    // A balance is a nicety — no balance shown beats an error about it.
    return undefined;
  }
}
