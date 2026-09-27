import {
  ProviderError,
  classifyHttp,
  messageOf,
  postJson,
  retryAfterFromHeaders,
  withRetry,
} from "@providerkit/core";
import { truncate } from "@/lib/logger";
import { JEV_HOSTS } from "./hosts";
import type { JevConnection, JevReply } from "./hosts";

/** Jev answers in ~0.4 s; a call still open after this is not coming back. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The one question type every host spells the same. */
export interface ChoiceQuestion {
  type: "choice";
  criteria: Record<string, unknown>;
  instructions?: unknown;
}

/** A Choice answer that passed validation, options ranked most likely first. */
export interface Choice {
  choice: string;
  p: number;
  ranked: { id: string; p: number }[];
}

/**
 * Cloudflare answers a wrong account id with a 404 (code 7003) that
 * classifyHttp reads as a missing model; the fix is the account id, so it is
 * an auth failure.
 */
function reclassify(e: unknown): unknown {
  if (e instanceof ProviderError && e.status === 404 && e.body?.includes("7003")) {
    return new ProviderError("jev", "auth", e.message, { status: 404, body: e.body, cause: e });
  }
  return e;
}

/** A GET that proves a key — the one request postJson doesn't cover. */
async function getOk(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    // Stop is the caller's, not a failure — it leaves exactly as it arrived.
    if (signal?.aborted) throw e;
    throw new ProviderError("jev", timeout.aborted ? "timeout" : "network", messageOf(e), {
      cause: e,
    });
  }
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  const retryAfterMs = retryAfterFromHeaders(res.headers);
  throw reclassify(
    new ProviderError("jev", classifyHttp(res.status, body), `HTTP ${res.status}`, {
      status: res.status,
      body: truncate(body, 300),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }),
  );
}

/**
 * One Jev request. Rate limits and overloads (429/503/529) retry with backoff,
 * honoring Retry-After; everything else throws a classified ProviderError.
 */
export async function askJev(
  conn: JevConnection,
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  signal?: AbortSignal,
): Promise<JevReply> {
  const host = JEV_HOSTS[conn.host];
  return withRetry(
    async () => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let json: unknown;
      try {
        json = await postJson({
          url: host.url(conn),
          headers: host.headers(conn),
          body: host.body(state, questions),
          provider: "jev",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (timeout.aborted && !signal?.aborted) {
          throw new ProviderError("jev", "timeout", "no answer in 15 s", { cause: e });
        }
        throw reclassify(e);
      }
      const reply = host.unwrap(json);
      if (!reply) {
        throw new ProviderError("jev", "invalid", "unreadable reply", {
          body: truncate(JSON.stringify(json) ?? "", 300),
        });
      }
      return reply;
    },
    { maxAttempts: 3, maxDelayMs: 10_000, ...(signal ? { signal } : {}) },
  );
}

const isProbability = (p: unknown): p is number =>
  typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

/**
 * Reads one Choice answer, or null when it isn't one for these options. An
 * answer that fails here never becomes an action. jev-ultrafast's rule: the
 * pick must be offered, the distribution must name exactly the offered
 * options and sum to 1 (within rounding drift — eight live options have been
 * seen summing to 0.98), and the pick must be its favorite. An answer with
 * only a `confidence` is refused, never filled in: TypeSafe's confidence
 * measures how the distribution is spread, not P(pick).
 */
export function readChoice(answer: unknown, ids: string[]): Choice | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { choice, probabilities } = answer as Record<string, unknown>;
  if (typeof choice !== "string" || !ids.includes(choice)) return null;

  if (typeof probabilities !== "object" || probabilities === null) return null;
  const entries = Object.entries(probabilities);
  if (entries.length !== ids.length || !entries.every(([id]) => ids.includes(id))) return null;
  const ranked: { id: string; p: number }[] = [];
  for (const [id, p] of entries) {
    if (!isProbability(p)) return null;
    ranked.push({ id, p });
  }
  const sum = ranked.reduce((total, r) => total + r.p, 0);
  const nonzero = ranked.filter((r) => r.p > 0).length;
  if (Math.abs(sum - 1) > Math.min(0.05, Math.max(0.01, 0.005 * nonzero))) return null;
  ranked.sort((a, b) => b.p - a.p);
  const top = ranked[0];
  const picked = ranked.find((r) => r.id === choice);
  if (!top || !picked || picked.p < top.p - 1e-6) return null;
  return { choice, p: picked.p, ranked };
}

/**
 * Proves a key works before it is saved. Uses the host's free read where it
 * has one; Vercel has none, so a one-question request stands in (a few dozen
 * tokens — a fraction of a cent).
 */
export async function checkJevKey(conn: JevConnection, signal?: AbortSignal): Promise<void> {
  const probe = JEV_HOSTS[conn.host].check(conn);
  if (probe) {
    await getOk(probe.url, probe.headers, signal);
    return;
  }
  const reply = await askJev(
    conn,
    { text: "Key check." },
    { ok: { type: "choice", criteria: { YES: "Yes.", NO: "No." } } },
    signal,
  );
  if (!readChoice(reply.answers.ok, ["YES", "NO"])) {
    throw new ProviderError("jev", "invalid", "unreadable reply");
  }
}

/** OpenRouter's remaining balance in US$ — the one host that reports one. */
export async function openRouterBalance(apiKey: string): Promise<number | undefined> {
  try {
    const res = await getOk("https://openrouter.ai/api/v1/credits", {
      Authorization: `Bearer ${apiKey}`,
    });
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
