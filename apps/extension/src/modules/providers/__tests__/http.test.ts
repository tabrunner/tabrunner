import { describe, expect, it } from "vitest";
import {
  dataPolicyConsentUrl,
  envelopeProviderError,
  googleRetryAfterMs,
  providerHeaders,
  sessionHeaders,
} from "../http";
import { isRetryable, type ChatMessage } from "../types";

describe("sessionHeaders", () => {
  it("sends Go the conversation id under OpenCode's routing header", async () => {
    expect(await sessionHeaders("opencode-go", "conv-1")).toEqual({
      "x-opencode-session": "conv-1",
    });
  });

  it("sends Zen the full OpenCode client set, with the id forged into the ses_ shape", async () => {
    // The free tier checks the shape: a plain conversation id gets FreeTierError.
    const headers = await sessionHeaders("opencode", "conv-1");
    const ses = headers["x-opencode-session"]!;
    expect(ses).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headers).toEqual({
      "x-opencode-session": ses,
      "x-opencode-session-id": ses,
      "x-session-affinity": ses,
      "x-session-id": ses,
      "x-opencode-project": "global",
      "x-opencode-client": "cli",
    });
    // One conversation, one id — the gateway's affinity depends on it.
    expect(await sessionHeaders("opencode", "conv-1")).toEqual(headers);
    expect((await sessionHeaders("opencode", "conv-2"))["x-opencode-session"]).not.toBe(ses);
  });

  it("sends the ChatGPT backend its own name for the same id", async () => {
    expect(await sessionHeaders("chatgpt", "conv-1")).toEqual({ "session-id": "conv-1" });
  });

  it("sends nothing without a conversation — a probe outside any chat", async () => {
    expect(await sessionHeaders("opencode", undefined)).toEqual({});
  });

  it("sends nothing for providers whose preset doesn't ask", async () => {
    expect(await sessionHeaders("openai", "conv-1")).toEqual({});
    expect(await sessionHeaders("github-copilot", "conv-1")).toEqual({});
    expect(await sessionHeaders("custom-1", "conv-1")).toEqual({});
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

describe("envelopeProviderError", () => {
  it("explains the public free limit without account-credit or top-up advice", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached" },
    });
    const error = envelopeProviderError({ id: "opencode", name: "OpenCode Zen" }, 429, body);
    expect(error.kind).toBe("quota");
    expect(error.message).toContain("reports a free-usage limit");
    expect(error.message).toContain("It did not say when it resets");
    expect(error.message).toContain("connect another provider");
    expect(error.message).not.toMatch(/top.?up|billing|account balance|your plan/);
    expect(isRetryable(error)).toBe(false);
  });

  it("tells a spent ChatGPT window when it resets, now that it reads as quota", () => {
    // The codex backend's 429 for a spent plan window. @providerkit/core 0.16
    // names it `quota` (it was `rate` by status before), and the generic quota
    // line has no reset time — the one thing a subscriber needs to hear.
    const body = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_in_seconds: 2 * 3600,
      },
    });
    const error = envelopeProviderError({ id: "chatgpt", name: "ChatGPT" }, 429, body);
    expect(error.kind).toBe("quota");
    expect(error.message).toContain("reached your 5-hour usage limit");
    expect(error.message).toContain("It resets in 2 hours");
    expect(isRetryable(error)).toBe(false);
  });

  it("keeps the plain quota line when no window names a reset", () => {
    const body =
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}';
    const error = envelopeProviderError({ id: "openai", name: "OpenAI" }, 429, body);
    expect(error.kind).toBe("quota");
    expect(error.message).toContain("You have used up your quota with OpenAI");
  });
});

describe("providerHeaders", () => {
  it("bills a typed turn to the user and a tool-result turn to the agent on Copilot", () => {
    // One premium request per user turn; the run's own follow-ups ride free.
    const typed: ChatMessage[] = [{ role: "user", content: "hi" }];
    const followUp: ChatMessage[] = [
      ...typed,
      { role: "tool_results", content: "", toolResults: [] },
    ];
    expect(providerHeaders("github-copilot", typed)["X-Initiator"]).toBe("user");
    expect(providerHeaders("github-copilot", followUp)["X-Initiator"]).toBe("agent");
    expect(providerHeaders("github-copilot", typed)["Editor-Version"]).toBe("TabRunner/0.0.0-test");
  });
});
