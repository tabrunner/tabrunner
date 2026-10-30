import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { AuthFlow, Credential } from "@providerkit/core/auth";
import { createGeminiProvider, toCoreMessages } from "../gemini";
import { listModels } from "../models";
import { saveProvider } from "../storage";
import {
  ProviderError,
  isRetryable,
  type ChatMessage,
  type ResolvedProviderConfig,
} from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

let refreshImpl: AuthFlow["refresh"] = () => Promise.reject(new Error("unset"));
vi.mock("../oauth-flows", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authFlowFor: (id: string) =>
    id === "antigravity"
      ? { signIn: vi.fn(), refresh: (credential: Credential) => refreshImpl(credential) }
      : undefined,
}));

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

  it("maps Gemini safety stops to content_filter and retries OTHER as overload", async () => {
    stubStream(200, nativeStream([{ candidates: [{ finishReason: "SAFETY" }] }]));
    const deltas = [];
    for await (const d of createGeminiProvider(geminiConfig()).stream(
      [],
      [],
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    expect(deltas).toContainEqual({ type: "finish", reason: "content_filter" });

    stubStream(200, nativeStream([{ candidates: [{ finishReason: "OTHER" }] }]));
    let caught: unknown;
    try {
      for await (const d of createGeminiProvider(geminiConfig()).stream(
        [],
        [],
        new AbortController().signal,
      )) {
        void d;
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe("overload");
    expect(isRetryable(caught)).toBe(true);
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

  it("keeps the server's `x-should-retry: false` that core read off the response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('[{"error":{"code":503,"message":"The model is overloaded."}}]', {
        status: 503,
        headers: { "x-should-retry": "false" },
      }),
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

    expect(error).toBeInstanceOf(ProviderError);
    expect(isRetryable(error)).toBe(false);
  });

  it("retries a stream core saw cut off before Gemini's finish reason", async () => {
    // From @providerkit/core 0.16 a stream that closes without a finish throws
    // `network`. That kind has no status and no body, so re-deriving it here
    // landed on `unknown`: a bare "answered 0", never retried.
    stubStream(200, nativeStream([{ candidates: [{ content: { parts: [{ text: "Half" }] } }] }]));

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

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("network");
    expect((error as ProviderError).message).toContain("stopped partway");
    expect(isRetryable(error)).toBe(true);
  });

  it("names a request that never reached Gemini as a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));

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

    expect((error as ProviderError).kind).toBe("network");
    expect((error as ProviderError).message).toContain("generativelanguage.googleapis.com");
    expect(isRetryable(error)).toBe(true);
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

describe("gemini bridge on Antigravity", () => {
  const updateSessionRules = vi.fn((_options: unknown) => Promise.resolve());
  const fresh: Credential = {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: Date.now() + 3_600_000,
    projectId: "proj-123",
  };
  const antigravity = (auth: Credential): ResolvedProviderConfig => ({
    id: "antigravity",
    name: "Google Antigravity",
    shape: "gemini",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "",
    auth,
    model: "gemini-3.8-flash",
    sessionId: "conversation-1",
    createdAt: 0,
  });
  const answer = () =>
    nativeStream([
      {
        response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
      },
    ]);

  beforeEach(() => {
    updateSessionRules.mockClear();
    (globalThis as Record<string, unknown>).chrome = {
      declarativeNetRequest: { updateSessionRules },
    };
  });

  async function drain(config: ResolvedProviderConfig) {
    const deltas = [];
    for await (const d of createGeminiProvider(config).stream(
      [{ role: "user", content: "hello" }],
      [],
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    return deltas;
  }

  it("sends the account's project in the envelope, to the internal path, as a bearer", async () => {
    await saveProvider(antigravity(fresh));
    const spy = stubStream(200, answer());

    const deltas = await drain(antigravity(fresh));

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer at-1");
    const body = JSON.parse(init?.body as string) as {
      model: string;
      project: string;
      userAgent: string;
      request: { contents: unknown[] };
    };
    expect(body).toMatchObject({
      // Core adds the effort tier to the wire id; only the family is ours to pin.
      model: expect.stringContaining("gemini-3.8-flash"),
      project: "proj-123",
      userAgent: "antigravity",
    });
    expect(body.request.contents.length).toBeGreaterThan(0);
    // The reply arrives wrapped in `response`; the text still comes out.
    expect(deltas).toContainEqual({ type: "text", text: "hi" });
  });

  it("puts the IDE user agent on the call through a rule, since fetch cannot", async () => {
    await saveProvider(antigravity(fresh));
    stubStream(200, answer());

    await drain(antigravity(fresh));

    const options = updateSessionRules.mock.calls[0]?.[0] as {
      addRules: chrome.declarativeNetRequest.Rule[];
    };
    expect(options.addRules[0]?.action.requestHeaders?.[0]?.value).toContain("antigravity/ide/");
  });

  it("renews an expired token before the call, because a run outlives one", async () => {
    const expired = { ...fresh, expiresAt: Date.now() - 1 };
    await saveProvider(antigravity(expired));
    refreshImpl = () => Promise.resolve({ ...fresh, accessToken: "at-2", refreshToken: "rt-2" });
    const spy = stubStream(200, answer());

    await drain(antigravity(expired));

    const init = spy.mock.calls[0]![1];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer at-2");
  });

  it("keeps one Antigravity session across turns of the same conversation", async () => {
    await saveProvider(antigravity(fresh));
    const sessions: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const spy = stubStream(
        200,
        nativeStream([{ response: { candidates: [{ finishReason: "STOP" }] } }]),
      );
      await drain(antigravity(fresh));
      const body = JSON.parse(spy.mock.calls[0]![1]?.body as string) as {
        request: { sessionId: string };
      };
      sessions.push(body.request.sessionId);
      vi.restoreAllMocks();
    }
    expect(sessions[0]).toBeTruthy();
    expect(sessions[1]).toBe(sessions[0]);
  });
});
