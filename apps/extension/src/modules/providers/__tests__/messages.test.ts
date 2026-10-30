import { describe, it, expect } from "vitest";
import { toOpenAIMessages } from "../openai";
import { toAnthropicMessage } from "../anthropic";
import type { ChatMessage } from "../types";

// Storage stand-in comes from src/test-setup.ts (vitest setupFiles).

const assistantWithTools: ChatMessage = {
  role: "assistant",
  content: "Let me click that.",
  toolCalls: [{ id: "c1", name: "click", args: { ref: "e1" } }],
};

const toolResults: ChatMessage = {
  role: "tool_results",
  content: "",
  toolResults: [
    { id: "c1", content: '{"x":100,"y":200}' },
    { id: "c2", content: '{"ok":true}' },
  ],
};

describe("OpenAI message mapping", () => {
  it("expands tool_results to one role:tool message per result", () => {
    const out = toOpenAIMessages(toolResults);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "tool", content: '{"x":100,"y":200}', tool_call_id: "c1" });
    expect(out[1]).toEqual({ role: "tool", content: '{"ok":true}', tool_call_id: "c2" });
  });

  it("maps assistant toolCalls to OpenAI function-call shape", () => {
    const out = toOpenAIMessages(assistantWithTools);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "click", arguments: '{"ref":"e1"}' } },
    ]);
  });

  it("passes plain messages through", () => {
    expect(toOpenAIMessages({ role: "user", content: "hi" })).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("Anthropic message mapping", () => {
  it("collapses tool_results into ONE user message of tool_result blocks", () => {
    const out = toAnthropicMessage(toolResults);
    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    const blocks = out.content as { type: string; tool_use_id: string; content: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: '{"x":100,"y":200}',
    });
  });

  it("maps assistant toolCalls to tool_use blocks", () => {
    const out = toAnthropicMessage(assistantWithTools);
    expect(out.role).toBe("assistant");
    const blocks = out.content as { type: string }[];
    expect(blocks[0]).toEqual({ type: "text", text: "Let me click that." });
    expect(blocks[1]).toMatchObject({ type: "tool_use", id: "c1", name: "click" });
  });

  it("keeps user/assistant alternation for plain messages", () => {
    expect(toAnthropicMessage({ role: "user", content: "hi" })).toEqual({
      role: "user",
      content: "hi",
    });
  });

  it("re-prefixes replayed tool_use names in OAuth mode", () => {
    const out = toAnthropicMessage(assistantWithTools, true);
    const blocks = out.content as { type: string }[];
    expect(blocks[1]).toMatchObject({ type: "tool_use", id: "c1", name: "custom_click" });
  });
});
