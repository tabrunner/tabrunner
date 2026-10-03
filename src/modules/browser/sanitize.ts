/**
 * Make an evaluate result safe and cheap to hand to the model: JSON-shaped,
 * bounded, and stripped of credential-looking values. The agent drives the
 * user's logged-in sessions, so a page (or a careless `evaluate(window)`) can
 * hand back tokens — they must not sail into the transcript and on to the
 * provider. Blocking beats leaking: a false positive (a git SHA reads as a hex
 * credential) costs the model one re-fetch with the value sliced in-page.
 */

const MAX_DEPTH = 5;
const MAX_STRING = 1000;
const MAX_ARRAY = 100;
/** Roughly half a page snapshot — plenty for an extracted table, far from a page dump. */
const MAX_RESULT_CHARS = 20_000;

const BLOCKED = "[blocked]";

const SENSITIVE_KEY =
  /pass(word|wd)|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session|cookie|csrf|jwt/i;
/**
 * Does this label name something credential-shaped? The same test the value
 * sanitizer runs on object keys, exposed for callers that hold a field's label
 * rather than a key — a walkthrough deciding whether to print what was typed
 * into it.
 */
export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_KEY.test(label);
}

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}/;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
/** `name=value; name=value` — a cookie or header string, never page prose. */
const COOKIE_PAIRS = /\b[^\s=;]{2,32}=[^;\s]{6,};\s*[^\s=;]{2,32}=/;
const LONG_BASE64 = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const LONG_HEX = /^(?:[0-9a-f]{2}){16,}$/i;

function sanitizeString(s: string): string {
  if (
    JWT.test(s) ||
    BEARER.test(s) ||
    COOKIE_PAIRS.test(s) ||
    LONG_BASE64.test(s) ||
    LONG_HEX.test(s)
  ) {
    return BLOCKED;
  }
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
}

export function sanitizeForModel(value: unknown): unknown {
  // A second sighting of an object is marked circular even when it is only
  // shared — distinguishing the two costs a path map the model never needs.
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return sanitizeString(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return `[${typeof v}]`;
    if (typeof v !== "object") return String(v);
    if (depth >= MAX_DEPTH) return "[truncated: max depth]";
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1));
      if (v.length > MAX_ARRAY) out.push(`[truncated: ${v.length - MAX_ARRAY} more items]`);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) {
      out[key] = SENSITIVE_KEY.test(key) ? BLOCKED : walk(val, depth + 1);
    }
    return out;
  };

  const cleaned = walk(value, 0);
  const json = JSON.stringify(cleaned) ?? "null";
  if (json.length <= MAX_RESULT_CHARS) return cleaned;
  return `${json.slice(0, MAX_RESULT_CHARS)}…[truncated at ${MAX_RESULT_CHARS} chars. Return a smaller piece]`;
}
