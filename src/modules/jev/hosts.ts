/**
 * Where a Jev request goes. The four hosts serve the same model and take the
 * same state + questions; they differ only in the envelope — URL, auth
 * headers, how the body is wrapped, and where the answers and the usage sit in
 * the reply. One table row per host, one `askJev` over all of them.
 *
 * Only Choice questions cross this seam: they are the one type all four
 * spell the same (Vercel renames Noul to "boolean").
 */

export type JevHostId = "typesafe" | "openrouter" | "cloudflare" | "vercel";

/** What a saved Jev setup needs to reach its host. */
export interface JevConnection {
  host: JevHostId;
  apiKey: string;
  /** Cloudflare only: the account the Workers AI call is billed to. */
  accountId?: string;
}

/** TypeSafe's list price, per input token. Output tokens are free. */
export const JEV_INPUT_PRICE = 0.042 / 1_000_000;

/** A host's reply, reduced to what the executor reads. */
export interface JevReply {
  answers: Record<string, unknown>;
  inputTokens: number;
  /** US$ — the host's own figure when it reports one, else tokens × list price. */
  cost: number;
}

export interface JevHost {
  /** Brand name — never translated. */
  label: string;
  /** Where to get a key. */
  keyUrl: string;
  /** Where the host shows spend and balance. */
  usageUrl: string;
  url(c: JevConnection): string;
  headers(c: JevConnection): Record<string, string>;
  body(state: unknown, questions: Record<string, unknown>): unknown;
  /** Null when the reply isn't one this host sends for a finished request. */
  unwrap(json: unknown): JevReply | null;
  /** A request that proves the key works without spending tokens — or null
   *  when the host has none, and a one-question request stands in. */
  check(c: JevConnection): { url: string; headers: Record<string, string> } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const bearer = (c: JevConnection) => ({ Authorization: `Bearer ${c.apiKey}` });

/** TypeSafe's reply shape — the other hosts pass it through or wrap it. */
function plainReply(json: unknown): JevReply | null {
  if (!isRecord(json) || !isRecord(json.answers)) return null;
  const usage = isRecord(json.usage) ? json.usage : {};
  const inputTokens = num(usage.input_tokens) ?? num(usage.inputTokens) ?? 0;
  return {
    answers: json.answers,
    inputTokens,
    cost: num(usage.cost) ?? inputTokens * JEV_INPUT_PRICE,
  };
}

export const JEV_HOSTS: Record<JevHostId, JevHost> = {
  typesafe: {
    label: "TypeSafe",
    keyUrl: "https://console.typesafe.ai/settings/keys",
    usageUrl: "https://console.typesafe.ai",
    url: () => "https://api.typesafe.ai/v1/systemone",
    headers: bearer,
    body: (state, questions) => ({ model: "jev-latest", state, questions }),
    unwrap: plainReply,
    check: (c) => ({ url: "https://api.typesafe.ai/v1/models", headers: bearer(c) }),
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    usageUrl: "https://openrouter.ai/activity",
    // ponytail: OpenRouter's /systemone route is in alpha. If it moves, this
    // row is the whole fix.
    url: () => "https://openrouter.ai/api/v1/systemone",
    headers: bearer,
    body: (state, questions) => ({ model: "typesafe/jev-1.13", state, questions }),
    unwrap: plainReply,
    check: (c) => ({ url: "https://openrouter.ai/api/v1/credits", headers: bearer(c) }),
  },
  cloudflare: {
    label: "Cloudflare",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    usageUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
    url: (c) =>
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.accountId ?? "")}/ai/run`,
    headers: bearer,
    body: (state, questions) => ({ model: "typesafe/jev", input: { state, questions } }),
    // Workers AI wraps twice: the API envelope, then the task record.
    unwrap: (json) => {
      if (!isRecord(json) || json.success === false || !isRecord(json.result)) return null;
      const task = json.result;
      if (typeof task.status === "string" && task.status !== "Completed") return null;
      return plainReply(isRecord(task.result) ? task.result : task);
    },
    // Lists Workers AI models on the account: proves the token, the account
    // id and the AI permission in one read.
    check: (c) => ({
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.accountId ?? "")}/ai/models/search?per_page=1`,
      headers: bearer(c),
    }),
  },
  vercel: {
    label: "Vercel AI Gateway",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys",
    usageUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai",
    url: () => "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    headers: (c) => ({
      ...bearer(c),
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
    }),
    body: (state, questions) => ({ state, questions }),
    unwrap: plainReply,
    check: () => null,
  },
};
