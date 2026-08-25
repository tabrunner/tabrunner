import { createLogger } from "@/lib/logger";
import { stampDelivery, listHookRules } from "./store";
import {
  HOOK_TIMEOUT_MS,
  MAX_HOOK_STRING_CHARS,
  type HookEvent,
  type HookRule,
} from "./types";

/**
 * Delivery: read rules, POST the event's JSON to each match, stamp the
 * receipt. Fire-and-forget by contract — `fireHook` never throws and never
 * awaits; `hooksPending()` is the one join point (start-run folds it into the
 * memory keepalive window so a run_finished delivery isn't killed mid-POST
 * when the worker goes idle).
 */

const log = createLogger("hooks");

const inFlight = new Set<Promise<void>>();

/** Fire every enabled rule matching `event`. Never throws, never awaits. */
export function fireHook(event: HookEvent, payload: Record<string, unknown>): void {
  // The batch joins `inFlight` synchronously, before its first delivery can
  // even start — tracking deliveries individually on top would bookkeep the
  // same settling twice.
  const batch = (async () => {
    let rules: HookRule[];
    try {
      rules = (await listHookRules()).filter((r) => r.enabled && r.event === event);
    } catch {
      return; // no registry, no delivery — nothing to report to either side
    }
    const body = clip({ event, timestamp: Date.now(), ...payload });
    await Promise.allSettled(rules.map((rule) => deliver(rule, body)));
  })();
  inFlight.add(batch);
  void batch.finally(() => inFlight.delete(batch));
}

/** Resolves once every delivery started so far has settled — the keepalive join. */
export async function hooksPending(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

async function deliver(rule: HookRule, body: string): Promise<void> {
  let ok: boolean;
  let status: number | undefined;
  try {
    // Header VALUES ride verbatim but are never logged — only the outcome is.
    const res = await fetch(rule.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(rule.headers ?? {}) },
      body,
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    ok = res.ok;
    status = res.status;
  } catch {
    ok = false;
  }
  await stampDelivery(rule.id, { at: Date.now(), ok, ...(status !== undefined ? { status } : {}) });
  if (!ok) log.debug("delivery failed", rule.event, status ?? "network");
}

/** Bound long strings at the source so the envelope stays small by construction. */
function clip(payload: Record<string, unknown>): string {
  const bounded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    bounded[k] =
      typeof v === "string"
        ? v.slice(0, MAX_HOOK_STRING_CHARS)
        : Array.isArray(v)
          ? v.map((x) => (typeof x === "string" ? x.slice(0, MAX_HOOK_STRING_CHARS) : x))
          : v;
  }
  return JSON.stringify(bounded);
}
