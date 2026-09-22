import { describe, it, expect, vi, afterEach } from "vitest";
import { createGeminiProvider, toCoreMessages } from "../gemini";
import { listModels } from "../models";
import { ProviderError, type ChatMessage, type ResolvedProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

function geminiConfig(): ResolvedProviderConfig {
  return {
    id: "gemini",
    name: "Gemini",
    shape: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "sk-test",
    // As the picker holds it — prefixed. The REST path wants the bare id.
    model: "models/gemini-3.5-flash-lite",
    createdAt: 0,
  };
}

/** Native SSE frames (`?alt=sse`), as the endpoint sends them. */
function nativeStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
}

function stubStream(status: number, body: BodyInit) {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status }));
  return spy;
}

afterEach(() => vi.restoreAllMocks());

const snapshotTool = {
  name: "snapshot",
  description: "See the page",
  params: { type: "object" as const, properties: {} },
};

describe("gemini bridge stream", () => {
  it("talks native REST: bare model, key header, contents + declarations", async () => {
    const spy = stubStream(
      200,
      nativeStream([
        {
          candidates: [
            { content: { parts: [{ text: "thinking…", thought: true }, { text: "hello!" }] } },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "snapshot", args: {}, id: "1" },
                    thoughtSignature: "sig1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 15000,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 5000,
            cachedContentTokenCount: 1000,
          },
        },
      ]),
    );

    const deltas = [];
    for await (const d of createGeminiProvider(geminiConfig()).stream(
      [{ role: "user", content: "hello" }],
      [snapshotTool],
      new AbortController().signal,
    )) {
      deltas.push(d);
    }

    const [url, init] = spy.mock.calls[0]!;
    // One /v1beta (core appends its own) and no models/ prefix.
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse",
    );
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-test");
    const body = JSON.parse(init?.body as string) as {
      contents: unknown[];
      tools: { functionDeclarations: { name: string }[] }[];
    };
    expect(body.contents.length).toBeGreaterThan(0);
    expect(body.tools[0]!.functionDeclarations[0]!.name).toBe("snapshot");

    // Thoughts surface as reasoning, text as text — nothing streams invisibly.
    expect(deltas).toContainEqual({ type: "reasoning", text: "thinking…" });
    expect(deltas).toContainEqual({ type: "text", text: "hello!" });
    // Thoughts bill as output; the cached slice rides separately.
    expect(deltas).toContainEqual({
      type: "usage",
      input: 15000,
      output: 5010,
      cacheRead: 1000,
    });
    // The signature survives the turn — without it the next round loses the
    // chain and the model ends calls mid-task with a thought-only STOP.
    const toolUse = deltas.find((d) => d.type === "tool_use");
    expect(toolUse).toMatchObject({ id: "1", name: "snapshot", thoughtSignature: "sig1" });
    expect(deltas).toContainEqual({ type: "finish", reason: "tool_use" });
    expect(deltas[deltas.length - 1]).toEqual({ type: "done" });
  });

  it("normalizes core failures through the shared envelope", async () => {
    stubStream(
      400,
      '[{"error":{"code":400,"message":"API key not valid. Pass a valid API key."}}]',
    );

    const error = await (async () => {
      try {
        for await (const delta of createGeminiProvider(geminiConfig()).stream(
          [],
          [],
          new AbortController().signal,
        )) {
          void delta;
        }
      } catch (e) {
        return e;
      }
      throw new Error("expected the stream to throw");
    })();

    const err = error as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("rejected the API key");
  });
});

describe("toCoreMessages", () => {
  it("recovers tool names from history and passes reasoning and signatures", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        reasoning: "plan",
        toolCalls: [{ id: "c1", name: "snapshot", args: {}, thoughtSignature: "sig0" }],
      },
      { role: "tool_results", content: "", toolResults: [{ id: "c1", content: "page" }] },
    ];
    const core = toCoreMessages(messages);
    const tool = core.find((m) => m.role === "tool");
    // The name is what functionResponse keys on — our result rows don't carry it.
    expect(tool).toMatchObject({ toolCallId: "c1", name: "snapshot", content: "page" });
    const assistant = core.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ reasoning: "plan" });
    expect(
      (assistant as { toolCalls?: { thoughtSignature?: string }[] }).toolCalls?.[0],
    ).toMatchObject({ thoughtSignature: "sig0" });
  });

  it("sends screenshots as image parts and drops what isn't an image", () => {
    const core = toCoreMessages([
      {
        role: "user",
        content: "look",
        images: ["data:image/png;base64,AAAA", "not-a-data-url"],
      },
    ]);
    expect(core).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
      },
    ]);
  });
});

describe("gemini listing", () => {
  it("parses the native catalog: strips models/, keeps display names, drops non-chat", async () => {
    const spy = stubStream(
      200,
      JSON.stringify({
        models: [
          { name: "models/gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite" },
          { name: "models/gemini-embedding-001", displayName: "Embedding" },
          { name: "models/imagen-4", displayName: "Imagen" },
        ],
      }),
    );

    const models = await listModels({
      id: "gemini",
      shape: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "sk-test",
    });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("sk-test");
    expect(models).toEqual([{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" }]);
  });
});
