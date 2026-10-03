import { truncate } from "@/lib/logger";
import { isRecord } from "@/shared/types";

/**
 * Split a provider error line into a human summary and a raw JSON detail blob.
 * Adapters throw `Anthropic API error 400: {"error":{...}}`. The status alone
 * ("error 403") says nothing actionable, so the provider's own message is lifted
 * into the summary and the full JSON stays behind the Details disclosure.
 *
 * `lead` is the summary without the provider's raw sentence — already fully
 * actionable when the error was classified (its kind lead line is self-contained),
 * so classified errors render the lead alone and skip the English echo.
 */
export function splitErrorDetail(message: string): {
  summary: string;
  lead: string;
  detail?: string;
} {
  // The body may be an object ({...}) or an array ([{...}] — Google wraps its
  // error bodies in an array), so start at whichever delimiter lands first.
  const brace = message.indexOf("{");
  const bracket = message.indexOf("[");
  const start = bracket === -1 || (brace !== -1 && brace < bracket) ? brace : bracket;
  if (start === -1) return { summary: message, lead: message };

  const candidate = message.slice(start).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { summary: message, lead: message };
  }

  const prefix = message.slice(0, start).replace(/[:\s]+$/, "");
  if (!prefix) return { summary: message, lead: message };

  const reason = findReason(parsed);
  return {
    summary: reason ? `${prefix}: ${truncate(reason, 300)}` : prefix,
    lead: prefix,
    detail: candidate,
  };
}

/**
 * Human-readable line out of a provider error body. Providers and proxies wrap
 * errors in arbitrary shells — OpenAI's `{error:{message}}`, Anthropic's
 * `{type:"error",error:{message}}`, gateways that serialize the upstream error
 * (sometimes a whole SSE frame) into their own `message` — so unwrap until the
 * innermost real text is found.
 */
function findReason(body: unknown, depth = 0): string | undefined {
  // Array-wrapped error bodies (Google) carry the real error in the first element.
  if (Array.isArray(body) && body.length > 0) body = body[0];
  if (!isRecord(body) || depth > 3) return undefined;
  const source = isRecord(body.error) ? body.error : body;
  const candidates = [
    isString(body.error) ? body.error : undefined,
    source.message,
    source.detail,
    body.message,
    body.detail,
  ];
  for (const value of candidates) {
    if (!isString(value) || !value.trim()) continue;
    const text = value.trim();
    const nested = embeddedJson(text);
    if (nested !== undefined) {
      // Wrapper string: readable text lives one level deeper, if at all.
      const inner = findReason(nested, depth + 1);
      if (inner) return inner;
      continue;
    }
    // A serialized SSE frame with no JSON payload ("data: [DONE]") is noise.
    if (/(?:^|\n)\s*(?:event|data)\s*:/.test(text)) continue;
    return text;
  }
  return undefined;
}

/**
 * JSON hiding inside a string value — bare JSON or an SSE frame like
 * `data: {"error":...}`. Parsed from the first `{` on; undefined if none.
 */
function embeddedJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start).trim());
  } catch {
    return undefined;
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
