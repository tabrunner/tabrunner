import { describe, it, expect } from "vitest";
import { classify, isTransportFailure } from "@providerkit/core";
import { ProviderError, isRetryable } from "../types";

/**
 * These cases were tabrunner's own classifier tests. The classifier now lives
 * in @providerkit/core — pooled with four other codebases' — so they stay here
 * as the boundary check: every failure this extension had already learned to
 * name must still be named the same way by the shared one.
 *
 * `classify` takes the error first and the status/body as overrides, which is
 * what the streaming paths use. Here there is no error object, only what came
 * back on the wire.
 */
const kind = (status: number, body: string) => classify(undefined, status, body);

describe("classify", () => {
  it("names quota exhaustion under whichever status the vendor picks", () => {
    // OpenAI files it under 429, DeepSeek 402, xAI 403, Anthropic 400.
    expect(
      kind(
        429,
        '{"error":{"message":"You exceeded your current quota, please check your plan","type":"insufficient_quota"}}',
      ),
    ).toBe("quota");
    expect(kind(402, '{"error":{"message":"credit balance is too low"}}')).toBe("quota");
    expect(
      kind(
        400,
        '{"error":{"message":"credit_balance_too_low: Your credit balance is too low to call the API"}}',
      ),
    ).toBe("quota");
    expect(kind(403, '{"error":"usage limit reached"}')).toBe("quota");
    expect(kind(429, '{"error":"reached your usage limit"}')).toBe("quota");
  });

  it("reads Chinese quota phrasings from Chinese-market providers", () => {
    expect(kind(400, '{"error":"余额不足，请充值"}')).toBe("quota");
    expect(kind(400, '{"error":"账户欠费"}')).toBe("quota");
    expect(kind(400, '{"error":"额度已用完"}')).toBe("quota");
  });

  it("puts entitlement ahead of quota — both mention plans and upgrades", () => {
    expect(
      kind(403, '{"error":"Your plan doesn\'t include API access. Upgrade to Pro or higher"}'),
    ).toBe("entitlement");
  });

  it("recognizes rejected credentials by text even under odd statuses", () => {
    expect(kind(400, '{"error":"API key not valid"}')).toBe("auth");
    expect(
      kind(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    ).toBe("auth");
    // Status fallback when the body says nothing recognizable.
    expect(kind(401, "")).toBe("auth");
    expect(kind(403, "Forbidden")).toBe("auth");
  });

  it("recognizes retired or unknown models", () => {
    expect(kind(404, '{"error":{"message":"No model named claude-old"}}')).toBe("model");
    expect(kind(400, '{"error":{"message":"The model `gpt-x` does not exist"}}')).toBe("model");
    expect(kind(404, "")).toBe("model");
  });

  it("falls back to status for plain rate limits and server failures", () => {
    expect(kind(429, '{"error":"requests per minute exceeded"}')).toBe("rate");
    expect(kind(529, '{"error":{"type":"overloaded_error"}}')).toBe("overload");
    expect(kind(500, "Internal Server Error")).toBe("overload");
  });

  it("answers `invalid` where the local classifier used to answer undefined", () => {
    // The shared classifier always names something. A 4xx it cannot place is
    // `invalid` — our request was wrong and the body says how — and http.ts
    // maps that to the generic envelope, which is exactly where an undefined
    // landed before. Behaviour at the UI is unchanged; only the name is new.
    expect(kind(400, '{"error":"temperature is not supported"}')).toBe("invalid");
    expect(kind(418, "")).toBe("invalid");
  });
});

describe("isRetryable with classified kinds", () => {
  it("never retries permanent kinds, even on transient-looking statuses", () => {
    // The one that bites in practice: OpenAI insufficient_quota is a 429.
    expect(isRetryable(new ProviderError("quota", 429, "quota"))).toBe(false);
    expect(isRetryable(new ProviderError("entitled", 429, "entitlement"))).toBe(false);
    expect(isRetryable(new ProviderError("model", 500, "model"))).toBe(false);
  });

  it("probes an auth rejection instead of trusting it — Kimi flakes on good keys", () => {
    const body =
      '{"error":{"type":"authentication_error","message":"The API Key appears to be invalid or may have expired. Please verify your credentials and try again."},"type":"error"}';
    expect(kind(401, body)).toBe("auth");
    expect(isRetryable(new ProviderError("auth", 401, "auth"))).toBe(true);
    // Still permanent once the body names a cause backoff can't fix.
    expect(isRetryable(new ProviderError("quota", 401, "quota"))).toBe(false);
  });

  it("retries a timeout — the shared classifier names one where a status used to", () => {
    // A 408, or a body saying the request timed out, used to reach the loop as
    // a bare 4xx and die. Now it has a name, and naming it must not narrow the
    // policy: the copy that ships with it tells the user to retry, which is
    // exactly what the loop should have done first.
    expect(kind(408, "")).toBe("timeout");
    expect(isRetryable(new ProviderError("timeout", 408, "timeout"))).toBe(true);
    // Still bounded by the server's own wait, like every other transient kind.
    expect(isRetryable(new ProviderError("timeout", 408, "timeout", 3_600_000))).toBe(false);
  });

  it("still retries transient kinds and unclassified transient statuses", () => {
    expect(isRetryable(new ProviderError("rate", 429, "rate"))).toBe(true);
    expect(isRetryable(new ProviderError("overload", 529, "overload"))).toBe(true);
    expect(isRetryable(new ProviderError("plain", 429))).toBe(true);
    expect(isRetryable(new ProviderError("plain", 400))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("gives up when the server's wait is a usage window, not a blip", () => {
    // Subscription 5h/weekly limits come with retry-after of hours to days —
    // retrying in place would just fail three times slower.
    expect(isRetryable(new ProviderError("rate", 429, "rate", 3_600_000))).toBe(false);
    expect(isRetryable(new ProviderError("plain", 429, undefined, 300_000_000))).toBe(false);
    // Short hints stay transient and are honored by the retry sleep.
    expect(isRetryable(new ProviderError("rate", 429, "rate", 20_000))).toBe(true);
  });
});

describe("context overflow", () => {
  it("names the wordings providers actually use for an oversized prompt", () => {
    for (const body of [
      '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens"}}',
      '{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}',
      "Input is too long for requested model",
      "Please reduce the length of the messages",
    ]) {
      expect(kind(400, body)).toBe("context");
    }
  });

  it("does not swallow a per-minute token rate limit — waiting fixes that, compacting doesn't", () => {
    expect(kind(429, "Rate limit reached: Limit 30000 tokens per min (TPM)")).toBe("rate");
  });

  it("leaves an image-count rejection alone — compaction can't fix it", () => {
    expect(kind(400, "exceeds the maximum number of images allowed")).not.toBe("context");
  });
});

describe("isTransportFailure", () => {
  it("recognizes the request that never left, whichever engine words it", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "fetch failed",
    ]) {
      expect(isTransportFailure(new TypeError(message))).toBe(true);
    }
  });

  it("leaves a real TypeError on the loud path — a bug is not a blip", () => {
    // Misfiling this would retry a crash five times and keep it off the
    // Errors page it belongs on. The shared classifier keeps the guard where
    // it matters: the MESSAGE is what is matched, never the type alone.
    expect(isTransportFailure(new TypeError("driver.click is not a function"))).toBe(false);
  });

  it("no longer requires a TypeError — the cause chain is rarely one", () => {
    // Deliberate change on adopting the shared classifier. It walks `cause`
    // five deep to find the dead socket that carries no HTTP status, and a
    // nested cause is almost never a TypeError. An Error whose message says
    // "Failed to fetch" IS a transport failure; the old type check was a
    // conservative stand-in for the walk this one actually does.
    expect(isTransportFailure(new Error("Failed to fetch"))).toBe(true);
    expect(isTransportFailure({ cause: { cause: new Error("socket hang up") } })).toBe(true);
  });

  it("retries a network failure, however it arrived", () => {
    expect(isRetryable(new ProviderError("offline", 0, "network"))).toBe(true);
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryable(new TypeError("undefined is not iterable"))).toBe(false);
  });
});
