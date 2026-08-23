import { describe, it, expect, vi, afterEach } from "vitest";
import { isKeyRejected, listModels, pickLatestModel, resolveProviderModel } from "../models";
import { ProviderError } from "../types";
import type { ProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const anthropicConfig: ProviderConfig = {
  id: "kimi",
  name: "Kimi",
  shape: "anthropic",
  baseUrl: "https://api.kimi.ai/coding",
  apiKey: "sk-test",
  createdAt: 0,
};

const openaiConfig: ProviderConfig = {
  ...anthropicConfig,
  id: "openai",
  shape: "openai",
  baseUrl: "https://api.openai.com/v1",
};

function stubFetch(status: number, body: unknown) {
  const mock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("listModels", () => {
  it("hits /v1/models with dual auth on anthropic shape and normalizes created_at", async () => {
    const mock = stubFetch(200, {
      data: [
        { id: "kimi-for-coding", created: 1761264000, created_at: "2025-10-24T00:00:00Z" },
        { id: "k3", created_at: "2026-07-16T00:00:00Z" },
      ],
    });
    const models = await listModels(anthropicConfig);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("https://api.kimi.ai/coding/v1/models");
    const headers = init?.headers as Record<string, string>; // fetch init headers, set by listModels
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(models).toEqual([
      { id: "kimi-for-coding", created: 1761264000000 },
      { id: "k3", created: Date.parse("2026-07-16T00:00:00Z") },
    ]);
  });

  it("hits /models on openai shape and filters non-chat models out of big catalogs", async () => {
    const mock = stubFetch(200, {
      data: [
        { id: "gpt-5", created: 1760000000 },
        { id: "text-embedding-3-large", created: 1760000001 },
        { id: "whisper-1", created: 1760000002 },
        { id: "dall-e-3", created: 1760000003 },
        { id: "gpt-4o", created: 1750000000 },
      ],
    });
    const models = await listModels(openaiConfig);
    expect(mock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
    expect(models.map((m) => m.id)).toEqual(["gpt-5", "gpt-4o"]);
  });

  it("hides Google's non-chat families (Live, image, tts, veo, robotics, research) from the list", async () => {
    stubFetch(200, {
      data: [
        { id: "gemini-3.6-flash", created: 1790000000 },
        // Newest by created, but Live-API-only — must not win "Auto" (404s on generateContent).
        { id: "gemini-3.5-live-translate-preview", created: 1791000000 },
        { id: "gemini-3.1-flash-live-preview", created: 1789000000 },
        { id: "gemini-3.1-flash-tts-preview", created: 1788000000 },
        { id: "gemini-3.1-flash-image", created: 1787000000 },
        { id: "imagen-3", created: 1786000000 },
        { id: "veo-3.1-generate-preview", created: 1785000000 },
        { id: "gemini-robotics-er-1.5-preview", created: 1784000000 },
        { id: "deep-research-pro-preview-12-2025", created: 1783000000 },
        { id: "gemini-2.5-computer-use-preview-10-2025", created: 1782000000 },
        { id: "gemma-3-27b-it", created: 1781000000 },
      ],
    });
    const models = await listModels(openaiConfig);
    expect(models.map((m) => m.id)).toEqual(["gemini-3.6-flash", "gemma-3-27b-it"]);
  });

  it("keeps the endpoint's human label (anthropic display_name, openrouter name)", async () => {
    stubFetch(200, {
      data: [
        { id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" },
        { id: "openai/gpt-5", name: "OpenAI: GPT-5" },
        // A label that just echoes the id carries nothing — don't store it.
        { id: "k3", display_name: "k3" },
        { id: "glm-5.2" },
      ],
    });
    expect((await listModels(anthropicConfig)).map((m) => m.name)).toEqual([
      "Claude Sonnet 4.5",
      "OpenAI: GPT-5",
      undefined,
      undefined,
    ]);
  });

  it("throws ProviderError with status on non-OK", async () => {
    stubFetch(404, { message: "Not support" });
    const err = await listModels(anthropicConfig).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(404);
  });
});

describe("isKeyRejected", () => {
  it("says yes only when the endpoint refuses the credential", async () => {
    stubFetch(401, { error: { message: "invalid x-api-key" } });
    expect(await isKeyRejected(anthropicConfig)).toBe(true);
  });

  it("keeps an endpoint with no list route addable — a 404 proves nothing about the key", async () => {
    stubFetch(404, { message: "Not support" });
    expect(await isKeyRejected(anthropicConfig)).toBe(false);
  });

  it("keeps an unreachable endpoint addable — offline is not a rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(await isKeyRejected(anthropicConfig)).toBe(false);
  });
});

describe("pickLatestModel", () => {
  it("picks the newest by created", () => {
    expect(
      pickLatestModel([
        { id: "old", created: 1000 },
        { id: "new", created: 2000 },
        { id: "mid", created: 1500 },
      ])?.id,
    ).toBe("new");
  });

  it("falls back to list order when timestamps are missing", () => {
    expect(pickLatestModel([{ id: "a" }, { id: "b" }])?.id).toBe("b");
  });
});

describe("resolveProviderModel", () => {
  it("returns the persisted model without fetching", async () => {
    const mock = stubFetch(200, { data: [] });
    const resolved = await resolveProviderModel({ ...anthropicConfig, model: "k3[1m]" });
    expect(resolved.model).toBe("k3[1m]");
    expect(mock).not.toHaveBeenCalled();
  });

  it("auto-resolves to the newest listed model", async () => {
    stubFetch(200, {
      data: [
        { id: "kimi-for-coding", created: 1761264000 },
        { id: "k3", created: 1780000000 },
      ],
    });
    const resolved = await resolveProviderModel(anthropicConfig);
    expect(resolved.model).toBe("k3");
    expect(resolved.supportsImages).toBe(true);
  });

  it("marks the DeepSeek preset text-only, even on a persisted model", async () => {
    const resolved = await resolveProviderModel({
      id: "deepseek",
      name: "DeepSeek",
      shape: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      model: "deepseek-chat",
      createdAt: 0,
    });
    expect(resolved.supportsImages).toBe(false);
  });

  it("defaults to image-capable for families without a text-only flag", async () => {
    const resolved = await resolveProviderModel({ ...anthropicConfig, model: "k3" });
    expect(resolved.supportsImages).toBe(true);
  });

  it("falls back to the preset's first model when the endpoint can't list", async () => {
    stubFetch(404, {});
    const resolved = await resolveProviderModel(anthropicConfig);
    expect(resolved.model).toBe("k3"); // first entry of the refreshed kimi preset
  });

  it("throws a clear error when nothing can resolve a model", async () => {
    stubFetch(404, {});
    const custom = { ...anthropicConfig, id: "custom-1", name: "My box" };
    await expect(resolveProviderModel(custom)).rejects.toThrow(/Pick a model in Settings/);
  });
});
