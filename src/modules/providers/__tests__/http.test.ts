import { describe, expect, it } from "vitest";
import { dataPolicyConsentUrl, googleRetryAfterMs, sessionHeaders } from "../http";

describe("sessionHeaders", () => {
  it("sends OpenCode's routing header on Zen turns carrying a conversation", () => {
    expect(sessionHeaders("opencode", "conv-1")).toEqual({ "x-opencode-session": "conv-1" });
    expect(sessionHeaders("opencode-go", "conv-1")).toEqual({ "x-opencode-session": "conv-1" });
  });

  it("sends nothing without a conversation — a probe outside any chat", () => {
    expect(sessionHeaders("opencode", undefined)).toEqual({});
  });

  it("sends nothing for providers whose preset doesn't ask", () => {
    expect(sessionHeaders("openai", "conv-1")).toEqual({});
    expect(sessionHeaders("github-copilot", "conv-1")).toEqual({});
    expect(sessionHeaders("custom-1", "conv-1")).toEqual({});
  });
});

describe("dataPolicyConsentUrl", () => {
  const body =
    '{"type":"error","error":{"type":"DataPolicyError","message":"Este modelo coleta dados usados para melhorar sua qualidade e exige seu consentimento explícito: https://opencode.ai/workspace/wrk_01M34BH0N9B4AEMY5B3XMVQ39W/go"}}';

  it("lifts the workspace consent URL out of the gate's error body", () => {
    expect(dataPolicyConsentUrl(body)).toBe(
      "https://opencode.ai/workspace/wrk_01M34BH0N9B4AEMY5B3XMVQ39W/go",
    );
  });

  it("ignores bodies from any other failure", () => {
    expect(dataPolicyConsentUrl('{"error":{"message":"invalid x-api-key"}}')).toBeUndefined();
    expect(dataPolicyConsentUrl("")).toBeUndefined();
  });

  it("ignores a DataPolicyError with nowhere to send the user", () => {
    expect(dataPolicyConsentUrl('{"error":{"type":"DataPolicyError"}}')).toBeUndefined();
  });
});

describe("googleRetryAfterMs", () => {
  it("reads RetryInfo out of Google's array-wrapped quota body", () => {
    const body = JSON.stringify([
      {
        error: {
          code: 429,
          message: "You exceeded your current quota.",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }],
        },
      },
    ]);
    expect(googleRetryAfterMs(body)).toBe(3000);
  });

  it("reads fractional seconds and the prose fallback", () => {
    expect(googleRetryAfterMs('{"error":{"details":[{"retryDelay":"1.5s"}]}}')).toBe(1500);
    expect(googleRetryAfterMs("Please retry in 3.365734019s.")).toBe(3366);
  });

  it("names no wait when the body carries none", () => {
    expect(googleRetryAfterMs('{"error":{"message":"boom"}}')).toBeUndefined();
    expect(googleRetryAfterMs("not json")).toBeUndefined();
  });
});
