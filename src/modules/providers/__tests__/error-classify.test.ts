import { describe, it, expect } from "vitest";
import { classifyProviderError, isTransportFailure } from "../error-classify";
import { ProviderError, isRetryable } from "../types";

describe("classifyProviderError", () => {
  it("names quota exhaustion under whichever status the vendor picks", () => {
    // OpenAI files it under 429, DeepSeek 402, xAI 403, Anthropic 400.
    expect(
      classifyProviderError(
        429,
        '{"error":{"message":"You exceeded your current quota, please check your plan","type":"insufficient_quota"}}',
      ),
    ).toBe("quota");
    expect(classifyProviderError(402, '{"error":{"message":"credit balance is too low"}}')).toBe(
      "quota",
    );
    expect(
      classifyProviderError(
        400,
        '{"error":{"message":"credit_balance_too_low: Your credit balance is too low to call the API"}}',
      ),
    ).toBe("quota");
    expect(classifyProviderError(403, '{"error":"usage limit reached"}')).toBe("quota");
    expect(classifyProviderError(429, '{"error":"reached your usage limit"}')).toBe("quota");
  });

  it("reads Chinese quota phrasings from Chinese-market providers", () => {
    expect(classifyProviderError(400, '{"error":"余额不足，请充值"}')).toBe("quota");
    expect(classifyProviderError(400, '{"error":"账户欠费"}')).toBe("quota");
    expect(classifyProviderError(400, '{"error":"额度已用完"}')).toBe("quota");
  });

  it("puts entitlement ahead of quota — both mention plans and upgrades", () => {
    expect(
      classifyProviderError(
        403,
        '{"error":"Your plan doesn\'t include API access. Upgrade to Pro or higher"}',
      ),
    ).toBe("entitlement");
  });

  it("recognizes rejected credentials by text even under odd statuses", () => {
    expect(classifyProviderError(400, '{"error":"API key not valid"}')).toBe("auth");
    expect(
      classifyProviderError(
        401,
        '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe("auth");
    // Status fallback when the body says nothing recognizable.
    expect(classifyProviderError(401, "")).toBe("auth");
    expect(classifyProviderError(403, "Forbidden")).toBe("auth");
  });

  it("recognizes retired or unknown models", () => {
    expect(classifyProviderError(404, '{"error":{"message":"No model named claude-old"}}')).toBe(
      "model",
    );
    expect(
      classifyProviderError(400, '{"error":{"message":"The model `gpt-x` does not exist"}}'),
    ).toBe("model");
    expect(classifyProviderError(404, "")).toBe("model");
  });

  it("falls back to status for plain rate limits and server failures", () => {
    expect(classifyProviderError(429, '{"error":"requests per minute exceeded"}')).toBe("rate");
    expect(classifyProviderError(529, '{"error":{"type":"overloaded_error"}}')).toBe("overload");
    expect(classifyProviderError(500, "Internal Server Error")).toBe("overload");
  });

  it("returns undefined when nothing matches", () => {
    expect(classifyProviderError(400, '{"error":"temperature is not supported"}')).toBeUndefined();
    expect(classifyProviderError(418, "")).toBeUndefined();
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
    expect(classifyProviderError(401, body)).toBe("auth");
    expect(isRetryable(new ProviderError("auth", 401, "auth"))).toBe(true);
    // Still permanent once the body names a cause backoff can't fix.
    expect(isRetryable(new ProviderError("quota", 401, "quota"))).toBe(false);
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
      expect(classifyProviderError(400, body)).toBe("context");
    }
  });

  it("does not swallow a per-minute token rate limit — waiting fixes that, compacting doesn't", () => {
    expect(classifyProviderError(429, "Rate limit reached: Limit 30000 tokens per min (TPM)")).toBe(
      "rate",
    );
  });

  it("leaves an image-count rejection alone — compaction can't fix it", () => {
    expect(classifyProviderError(400, "exceeds the maximum number of images allowed")).not.toBe(
      "context",
    );
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
    // Errors page it belongs on.
    expect(isTransportFailure(new TypeError("driver.click is not a function"))).toBe(false);
    expect(isTransportFailure(new Error("Failed to fetch"))).toBe(false);
  });

  it("retries a network failure, however it arrived", () => {
    expect(isRetryable(new ProviderError("offline", 0, "network"))).toBe(true);
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryable(new TypeError("undefined is not iterable"))).toBe(false);
  });
});
