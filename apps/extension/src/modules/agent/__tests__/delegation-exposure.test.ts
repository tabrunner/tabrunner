import { afterEach, describe, expect, it, vi } from "vitest";
import { createDriver } from "@/modules/browser";
import { createProvider } from "@/modules/providers/factory";
import type {
  ChatMessage,
  ChatProvider,
  ResolvedProviderConfig,
  ToolDef,
} from "@/modules/providers/types";
import { runAgentLoop } from "../loop";

const config: ResolvedProviderConfig = {
  id: "test",
  name: "Test",
  shape: "openai",
  baseUrl: "https://example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  createdAt: 0,
};

function emptySseFor(shape: ResolvedProviderConfig["shape"]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload =
    shape === "anthropic"
      ? `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
      : shape === "responses"
        ? `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`
        : "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

async function captureBody(
  shape: ResolvedProviderConfig["shape"],
  messages: ChatMessage[],
  tools: ToolDef[],
): Promise<Record<string, unknown>> {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(emptySseFor(shape), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
  for await (const delta of createProvider({ ...config, shape }).stream(
    messages,
    tools,
    new AbortController().signal,
  )) {
    void delta;
  }
  return JSON.parse(String(spy.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("delegation exposure", () => {
  it.each([
    { enabled: true, supportsImages: true },
    { enabled: true, supportsImages: false },
    { enabled: false, supportsImages: true },
    { enabled: false, supportsImages: false },
  ])("offers both instructions and tool together: %j", async ({ enabled, supportsImages }) => {
    // Construct the real typed driver, but replace its only reachable operation.
    const driver = createDriver(-1, { ownerId: "delegation-exposure" });
    vi.spyOn(driver, "snapshot").mockResolvedValue({
      pageContent: 'textbox "Search" [ref=e1]',
      viewport: { width: 800, height: 600 },
      url: "https://shop.example/",
      title: "Shop",
      newRefs: 0,
    });
    const requests: { messages: ChatMessage[]; tools: ToolDef[] }[] = [];
    const provider: ChatProvider = {
      async *stream(messages, tools) {
        requests.push({ messages: structuredClone(messages), tools });
        yield requests.length === 1
          ? { type: "tool_use", id: "look", name: "snapshot", args: {} }
          : { type: "tool_use", id: "end", name: "done", args: { summary: "Checked." } };
        yield { type: "done" };
      },
    };

    await runAgentLoop({
      provider,
      driver,
      task: "Find coffee grinders under $100.",
      supportsImages,
      ...(enabled ? { jev: { host: "opencode", model: "jev-1.13-free" } } : {}),
      signal: new AbortController().signal,
      callbacks: {},
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toEqual(requests[0]?.tools);
    for (const request of requests) {
      const system = request.messages.find((m) => m.role === "system")?.content;
      expect(system?.includes("# Jev")).toBe(enabled);
      expect(request.tools.some((tool) => tool.name === "delegate")).toBe(enabled);
      expect(request.tools.some((tool) => tool.name === "screenshot")).toBe(supportsImages);
      if (!enabled) continue;

      expect(await captureBody("openai", request.messages, request.tools)).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: system }),
        ]),
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: "delegate" }) }),
        ]),
      });
      expect(await captureBody("anthropic", request.messages, request.tools)).toMatchObject({
        system: expect.arrayContaining([expect.objectContaining({ text: system })]),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "delegate", input_schema: expect.any(Object) }),
        ]),
      });
      expect(await captureBody("responses", request.messages, request.tools)).toMatchObject({
        instructions: system,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "delegate", parameters: expect.any(Object) }),
        ]),
      });
    }
  });
});
