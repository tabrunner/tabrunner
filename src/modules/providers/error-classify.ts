/**
 * Classify provider errors by what actually fixes them. The body is read
 * BEFORE the status: providers file the same root cause under whatever status
 * they like — quota exhaustion shows up as 429 (OpenAI), 402 (DeepSeek),
 * 403 (xAI), 400 (Anthropic) — so status alone gives the wrong advice:
 * "retry" for an empty balance, "check the key" for a plan that never
 * included the API. The raw body is scanned as text: the error-type strings
 * (`"type": "billing_error"`) serialize into it, so no JSON parsing is needed.
 *
 * ponytail: regexes over vendor phrasings. Ceiling: an unlisted phrasing
 * falls through to the generic error envelope — never worse than before.
 * Upgrade path is adding patterns as new wordings are seen in the wild.
 */
export type ErrorKind =
  | "entitlement"
  | "quota"
  | "auth"
  | "model"
  | "rate"
  | "overload"
  | "context"
  | "network";

/**
 * A request that never reached the provider: `fetch` rejects with a TypeError
 * and there is no status, no body, nothing for the patterns below to read. The
 * cause is always on this side of the wire — wifi dropped, a VPN reconnecting,
 * a proxy or blocker in the way, DNS, or a base URL whose host doesn't exist —
 * which is why it is a `network` kind and not a provider fault. It gets the
 * same treatment as a rate limit: an expected state with its own fix, warned
 * rather than errored, so a user's flaky wifi never fills chrome://extensions'
 * Errors page with our name.
 *
 * The message is checked, not just the type: `TypeError` is also what a real
 * bug throws ("x is not a function"), and misfiling one of those as a blip
 * would retry it three times and hide it from the Errors page it belongs on.
 *
 * ponytail: engine wordings — Chromium says "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource", Safari "Load failed", the
 * daemon's runtime "fetch failed". Ceiling: an unlisted one falls through to
 * the generic envelope — exactly where it lands today. Upgrade path is adding
 * the wording.
 */
const TRANSPORT_MESSAGES =
  /failed to fetch|fetch failed|network\s?error|load failed|unable to connect|connection (?:closed|refused|reset)/i;

export function isTransportFailure(e: unknown): boolean {
  return e instanceof TypeError && TRANSPORT_MESSAGES.test(e.message);
}

// The request outgrew the model's context window. Distinct from quota in the
// one way that matters: nothing about the account is wrong and waiting fixes
// nothing — the fix is to send less, which is what compaction does. Every
// provider files it under 400 with its own wording, so the body is all we have.
const CONTEXT_PATTERNS = [
  /context[_\s]length[_\s]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many (?:input )?tokens/i,
  /reduce the length of the (?:messages|prompt|input)/i,
  // Scoped to the thing that overflowed: a bare "exceeds the maximum" also
  // covers image counts and per-minute token rates, which compaction can't fix.
  /exceeds? the (?:model'?s? )?maximum (?:input |prompt |context )?(?:tokens?|length|context)/i,
];

// A plan that never included this API — neither a new key nor a top-up fixes
// it, and its wording overlaps both ("plan" appears in all three categories),
// so it is checked first.
const ENTITLEMENT_PATTERNS = [
  /plan does(?:n't| not) (?:include|support)/i,
  /not included (?:in|with) your .{0,40}plan/i,
  /upgrade to [\w ]{1,30}(?:or higher|plan)/i,
  /no api access/i,
];

// Balance or usage used up. Chinese-market providers (Moonshot, Alibaba,
// Z.ai) report it in Chinese.
const QUOTA_PATTERNS = [
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /insufficient (?:balance|credits?)/i,
  /credit balance is too low/i,
  /(?:no|out of) credits/i,
  // Both word orders occur: "usage limit reached" (Z.ai), "reached your
  // usage limit" (Kimi).
  /usage limits? (?:reached|exceeded|hit)/i,
  /reached your (?:usage|weekly|monthly|daily) limit/i,
  /(?:weekly|monthly|daily|plan) usage limit/i,
  /purchase extra usage/i,
  /upgrade your plan/i,
  /quota\b[^.]{0,40}\b(?:exhausted|exceeded|will be refreshed)/i,
  /balance (?:is )?(?:too low|not enough|insufficient)/i,
  /余额不足/,
  /欠费/,
  /额度(?:不足|已用完)/,
];

const MODEL_PATTERNS = [
  /(?:model|models\/)[^.{\n]{0,40}(?:not found|does not exist|unknown)/i,
  /no model named/i,
  /unsupported model/i,
];

const AUTH_PATTERNS = [
  /invalid (?:x-api-key|api[ _-]?key|token|credentials?)/i,
  /api[ _-]?key (?:is )?(?:not valid|invalid|incorrect)/i,
  /unauthorized/i,
  /authentication[_\s](?:failed|invalid|error)/i,
  /account (?:disabled|suspended|deactivated|banned)/i,
];

const matches = (patterns: RegExp[], text: string): boolean => patterns.some((p) => p.test(text));

/**
 * The kind of provider failure, or undefined when nothing recognizable
 * matches (the caller keeps its generic envelope). Body patterns outrank
 * status; within the patterns, entitlement outranks quota, quota outranks
 * auth — each earlier category's fix is useless for the later ones.
 */
export function classifyProviderError(status: number, bodyText: string): ErrorKind | undefined {
  // Context first: a 429 whose body says "too many tokens" can be either a
  // per-minute rate limit or an oversized prompt, and only the wordings above
  // — which name the window, not the rate — land here. Compaction is the fix,
  // and unlike "retry" it is one the user can act on immediately.
  if (status < 500 && matches(CONTEXT_PATTERNS, bodyText)) return "context";
  if (status < 500 && matches(ENTITLEMENT_PATTERNS, bodyText)) return "entitlement";
  if (status < 500 && matches(QUOTA_PATTERNS, bodyText)) return "quota";
  if (matches(MODEL_PATTERNS, bodyText)) return "model";
  if (status === 401 || status === 403 || matches(AUTH_PATTERNS, bodyText)) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return "model";
  if (status === 429) return "rate";
  if (status >= 500) return "overload";
  return undefined;
}
