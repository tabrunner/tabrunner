import { ProviderError, classifyHttp, messageOf, withRetry } from "@providerkit/core";
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

async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
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
  const retryAfter = Number(res.headers.get("retry-after"));
  throw new ProviderError("jev", classifyHttp(res.status, body), `HTTP ${res.status}`, {
    status: res.status,
    body: truncate(body, 300),
    ...(retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  });
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
      const res = await send(
        host.url(conn),
        {
          method: "POST",
          headers: { ...host.headers(conn), "Content-Type": "application/json" },
          body: JSON.stringify(host.body(state, questions)),
        },
        signal,
      );
      const json: unknown = await res.json().catch(() => null);
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

/**
 * Reads one Choice answer, or null when it isn't one for these options. An
 * answer that fails here never becomes an action — jev-ultrafast's
 * validate_choice rule: the pick must be offered, and it must be the most
 * likely option in its own distribution.
 */
export function readChoice(answer: unknown, ids: string[]): Choice | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { choice, probabilities } = answer as { choice?: unknown; probabilities?: unknown };
  if (typeof choice !== "string" || !ids.includes(choice)) return null;
  if (typeof probabilities !== "object" || probabilities === null) return null;
  const ranked: { id: string; p: number }[] = [];
  for (const [id, p] of Object.entries(probabilities)) {
    if (!ids.includes(id) || typeof p !== "number" || !Number.isFinite(p)) return null;
    ranked.push({ id, p });
  }
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
    await send(probe.url, { headers: probe.headers }, signal);
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
