import type { ModelRate } from "@providerkit/core";
import {
  createDecisionClient,
  defaultDecisionModel,
  listOpenRouterDecisionModels,
} from "@providerkit/core/decisions";
import type {
  DecisionClient,
  DecisionConfig,
  DecisionHost,
  DecisionModel,
} from "@providerkit/core/decisions";
import { TOKEN_BUDGET } from "./request";

/**
 * TabRunner's side of the five decision-model hosts. The wire (URLs, envelopes,
 * answer checks, retries, and OpenRouter's decision catalog) is
 * `@providerkit/core/decisions`; what stays here is what the package can't
 * know: how the hosts are named and linked in Settings, the fallback list when
 * offline, the price we bill at, and OpenRouter's balance.
 */

export type JevHost = DecisionHost;

/** In the order the settings picker lists them. */
export const JEV_HOST_IDS = [
  "opencode",
  "openrouter",
  "typesafe",
  "cloudflare",
  "vercel",
] as const satisfies readonly JevHost[];

/** Models OpenCode Zen serves on `/zen/v1/systemone`. */
export const OPENCODE_JEV_MODELS = ["jev-1.13-free", "jev-1.13"] as const;
export type OpenCodeJevModel = (typeof OPENCODE_JEV_MODELS)[number];

/** Cold-start fallback for OpenRouter's decision model picker before the live
 *  catalog lands (or when offline). Excludes `respan/span-01*`, which only
 *  accepts `noul` questions and cannot choose browser actions. */
export const OPENROUTER_FALLBACK_DECISION_MODELS: readonly DecisionModel[] = [
  {
    id: "baseten/mammoth-1:free",
    name: "Baseten: Mammoth 1 (free)",
    inputModalities: ["text"],
    contextLength: 16_384,
    rate: { input: 0, output: 0, cacheRead: 0 },
  },
  {
    id: "baseten/elephant-1:free",
    name: "Baseten: Elephant 1 (free)",
    inputModalities: ["text"],
    contextLength: 16_384,
    rate: { input: 0, output: 0, cacheRead: 0 },
  },
  {
    id: "inception/mercury-decide:free",
    name: "Inception: Mercury Decide (free)",
    inputModalities: ["text", "image"],
    contextLength: 65_536,
    rate: { input: 0, output: 0, cacheRead: 0 },
  },
  {
    id: "~typesafe/jev-latest",
    name: "TypeSafe: Jev Latest",
    inputModalities: ["text", "image"],
    contextLength: 262_144,
    rate: { input: 0.042, output: 0, cacheRead: 0.042 },
  },
];

/** Can this decision model answer `choice` questions for the browser executor? */
export function isExecutorCompatibleModel(model: Pick<DecisionModel, "questionTypes">): boolean {
  return !model.questionTypes || model.questionTypes.includes("choice");
}

/**
 * Lists OpenRouter decision models that can drive the browser executor (`choice`
 * questions supported), with free models sorted first. Falls back to the
 * cold-start list if the network call fails.
 */
export async function listOpenRouterExecutorModels(
  apiKey?: string,
  signal?: AbortSignal,
): Promise<DecisionModel[]> {
  try {
    const models = await listOpenRouterDecisionModels({
      ...(apiKey ? { apiKey } : {}),
      ...(signal ? { signal } : {}),
    });
    const compatible = models.filter(isExecutorCompatibleModel);
    if (compatible.length === 0) return [...OPENROUTER_FALLBACK_DECISION_MODELS];
    return compatible.sort((a, b) => {
      const aFree = (a.rate?.input ?? 1) === 0 ? 0 : 1;
      const bFree = (b.rate?.input ?? 1) === 0 ? 0 : 1;
      return aFree - bFree;
    });
  } catch {
    return [...OPENROUTER_FALLBACK_DECISION_MODELS];
  }
}

/** Token budget for one executor step, clamped to half of smaller models' windows. */
export function tokenBudgetForModel(model?: string, contextLength?: number): number {
  const windowTokens =
    contextLength ?? (/^baseten\/(mammoth|elephant)-1/i.test(model ?? "") ? 16_384 : undefined);
  if (!windowTokens || windowTokens <= 0) return TOKEN_BUDGET;
  return Math.min(TOKEN_BUDGET, Math.max(2_000, Math.floor(windowTokens / 2)));
}

/** What a saved Jev setup needs to reach its host. */
export type JevConnection = Pick<DecisionConfig, "host" | "apiKey" | "accountId" | "model">;

/** Stable id for a saved decision option: hosts with multiple models key by `host/model`. */
export function jevEntryId(conn: Pick<JevConnection, "host" | "model">): string {
  if (conn.host === "opencode" || conn.host === "openrouter") {
    const model = conn.model ?? defaultDecisionModel(conn.host);
    if (conn.host === "openrouter" && model === defaultDecisionModel("openrouter")) {
      return "openrouter";
    }
    return `${conn.host}/${model}`;
  }
  return conn.host;
}

/** TypeSafe's list price, US$ per million tokens: input only, output is free.
 *  OpenRouter's own bill and OpenCode's $0 free tier win over it (`costUsd`). */
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
  opencode: {
    label: "OpenCode Zen",
    keyUrl: "https://opencode.ai/zen",
    usageUrl: "https://opencode.ai/zen",
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    usageUrl: "https://openrouter.ai/activity",
  },
  typesafe: {
    label: "TypeSafe",
    keyUrl: "https://console.typesafe.ai/keys",
    usageUrl: "https://console.typesafe.ai",
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
export function jevClient(conn: JevConnection): DecisionClient {
  return createDecisionClient({
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
