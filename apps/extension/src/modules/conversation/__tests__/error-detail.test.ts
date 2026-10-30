import { describe, it, expect } from "vitest";
import { splitErrorDetail } from "../error-detail";

describe("splitErrorDetail", () => {
  it("lifts the provider's message into the summary and keeps the JSON as detail", () => {
    const body =
      '{"error":{"type":"invalid_request_error","message":"Invalid request Error"},"type":"error"}';
    expect(splitErrorDetail(`Provider error: Anthropic API error 400: ${body}`)).toEqual({
      summary: "Provider error: Anthropic API error 400: Invalid request Error",
      lead: "Provider error: Anthropic API error 400",
      detail: body,
    });
  });

  it("reads a bare string error body", () => {
    expect(splitErrorDetail('HTTP 502: {"error":"upstream timed out"}')).toEqual({
      summary: "HTTP 502: upstream timed out",
      lead: "HTTP 502",
      detail: '{"error":"upstream timed out"}',
    });
  });

  it("unwraps an array-wrapped body (Google's error format)", () => {
    const body =
      '[{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}]';
    expect(splitErrorDetail(`Provider error: OpenAI API error 429: ${body}`)).toEqual({
      summary: "Provider error: OpenAI API error 429: You exceeded your current quota",
      lead: "Provider error: OpenAI API error 429",
      detail: body,
    });
  });

  it("unwraps a gateway envelope whose message embeds the upstream error", () => {
    const inner =
      '{"error":{"code":"invalid_parameter_error","param":null,"message":"max_completion_tokens [4096] must be greater than thinking_budget [32768]","type":"invalid_request_error"},"id":"chatcmpl-1"}';
    const body = JSON.stringify({
      request_id: "r1",
      code: "InvalidParameter",
      message: `data: ${inner}`,
    });
    expect(splitErrorDetail(`Anthropic API error 400: ${body}`)).toEqual({
      summary:
        "Anthropic API error 400: max_completion_tokens [4096] must be greater than thinking_budget [32768]",
      lead: "Anthropic API error 400",
      detail: body,
    });
  });

  it("falls back to the wrapper string when the embedded JSON has no message", () => {
    expect(splitErrorDetail('HTTP 502: {"message":"data: [DONE]"}')).toEqual({
      summary: "HTTP 502",
      lead: "HTTP 502",
      detail: '{"message":"data: [DONE]"}',
    });
  });

  it("falls back to the status line when the body has no message", () => {
    expect(splitErrorDetail('HTTP 500:  {"oops":true}')).toEqual({
      summary: "HTTP 500",
      lead: "HTTP 500",
      detail: '{"oops":true}',
    });
  });

  it("truncates a runaway provider message", () => {
    const long = "x".repeat(400);
    const { summary } = splitErrorDetail(`HTTP 400: ${JSON.stringify({ message: long })}`);
    expect(summary).toBe(`HTTP 400: ${"x".repeat(300)}…`);
  });

  it("leaves plain messages untouched", () => {
    expect(splitErrorDetail("No active tab found.")).toEqual({
      summary: "No active tab found.",
      lead: "No active tab found.",
    });
  });

  it("leaves messages with non-JSON braces untouched", () => {
    const msg = "tool input_schema {type: object} was rejected";
    expect(splitErrorDetail(msg)).toEqual({ summary: msg, lead: msg });
  });
});
