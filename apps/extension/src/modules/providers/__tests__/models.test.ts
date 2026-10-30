import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkCredential,
  effectiveEffort,
  effortLevels,
  isKeyRejected,
  listStoredModels,
  knownModels,
  modelsTarget,
  readModelsCache,
  writeModelsCache,
  listModels,
  pickLatestModel,
  resolveProviderModel,
} from "../models";
import { PRESETS } from "../presets";
import { saveProvider } from "../storage";
import { ProviderError, REASONING_EFFORTS } from "../types";
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
        { id: "jev-1.13", created: 1781500000 },
        { id: "jev-1.13-free", created: 1781400000 },
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

describe("checkCredential", () => {
  it("hands the listing back with the verdict, so the add form can warm the cache", async () => {
    stubFetch(200, { data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] });
    const checked = await checkCredential(anthropicConfig);
    expect(checked.rejected).toBe(false);
    expect(checked.models.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
  });

  it("reports a rejection with no models to warm", async () => {
    stubFetch(401, { error: { message: "invalid x-api-key" } });
    expect(await checkCredential(anthropicConfig)).toEqual({ rejected: true, models: [] });
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

  it("keeps the first entry when timestamps are missing", () => {
    // The first is the auto convention everywhere (preset fallback, resolved
    // model, the picker's auto row) — last-wins named the oldest as "auto".
    expect(pickLatestModel([{ id: "a" }, { id: "b" }])?.id).toBe("a");
  });

  it("keeps the first entry on equal timestamps too", () => {
    expect(
      pickLatestModel([
        { id: "a", created: 1000 },
        { id: "b", created: 1000 },
      ])?.id,
    ).toBe("a");
  });

  it("treats a missing timestamp as older than any real one, either order", () => {
    expect(pickLatestModel([{ id: "no-ts" }, { id: "ts", created: 1 }])?.id).toBe("ts");
    expect(pickLatestModel([{ id: "ts", created: 1 }, { id: "no-ts" }])?.id).toBe("ts");
  });
});

describe("auto naming agrees with the run's fallback", () => {
  // The run resolves auto to `preset.models[0]` when nothing is stored or
  // listed; the picker names auto via pickLatestModel over that same list.
  // A tie-break flip here makes the chip say one model while the run uses
  // another — pinning the convention holds both surfaces in step.
  it("every preset's newest-by-tie-break is its first entry", () => {
    for (const preset of PRESETS) {
      if (preset.models.length === 0) continue;
      const latest = pickLatestModel(preset.models.map((id) => ({ id })));
      expect(latest?.id).toBe(preset.models[0]);
    }
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
      model: "deepseek-v4-flash",
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
    await expect(resolveProviderModel(custom)).rejects.toThrow(/Choose a model in the chat/);
  });
});

describe("modelsTarget", () => {
  it("lists from the host the credential is pinned to, not the preset's", async () => {
    // GitHub Copilot serves each plan from its own host; the preset only knows
    // the individual one, so a business seat would list against a host its
    // token is refused at.
    const { modelsTarget } = await import("../models");
    const target = modelsTarget({
      ...openaiConfig,
      id: "github-copilot",
      baseUrl: "https://api.individual.githubcopilot.com",
      auth: {
        accessToken: "tok",
        refreshToken: "gho",
        expiresAt: Date.now() + 60_000,
        baseUrl: "https://api.business.githubcopilot.com",
      },
    });
    expect(target.baseUrl).toBe("https://api.business.githubcopilot.com");
    expect(target.apiKey).toBe("tok");
  });
});

describe("listModels headers", () => {
  it("sends GitHub Copilot's editor fingerprint — its /models route demands it", async () => {
    const mock = stubFetch(200, { data: [{ id: "gpt-6-astra" }] });

    await listModels({ ...openaiConfig, id: "github-copilot" });
    const headers = mock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    // A listing is a person opening the picker, not the run following itself up.
    expect(headers["X-Initiator"]).toBe("user");
  });

  it("sends nothing extra for a provider whose preset declares no headers", async () => {
    const mock = stubFetch(200, { data: [] });

    await listModels(openaiConfig);
    const headers = mock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Authorization"]);
  });
});

describe("copilot listing filter", () => {
  const copilot = {
    ...openaiConfig,
    id: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
  };

  it("keeps picker-enabled models and drops disabled or tool-less ones", async () => {
    stubFetch(200, {
      data: [
        { id: "gpt-5.5", model_picker_enabled: true, policy: { state: "enabled" } },
        // Picking this one answers `model_not_supported` at run time.
        { id: "gpt-5.4", model_picker_enabled: true, policy: { state: "disabled" } },
        // An agent that cannot call tools is not a runnable engine.
        {
          id: "text-model",
          model_picker_enabled: true,
          policy: { state: "enabled" },
          capabilities: { supports: { tool_calls: false } },
        },
        // Never offered in the picker — not servable by this account.
        { id: "hidden-model", model_picker_enabled: false, policy: { state: "enabled" } },
      ],
    });
    expect((await listModels(copilot)).map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("falls back to policy-enabled models when no picker flag is set at all", async () => {
    // Some Individual accounts report false for every picker flag despite
    // explicit enabled policies — an empty list would hide the whole catalog.
    stubFetch(200, {
      data: [
        { id: "gpt-5.5", model_picker_enabled: false, policy: { state: "enabled" } },
        { id: "gpt-5.4", model_picker_enabled: false, policy: { state: "disabled" } },
      ],
    });
    expect((await listModels(copilot)).map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("leaves other providers' listings untouched", async () => {
    stubFetch(200, {
      data: [{ id: "gpt-5", model_picker_enabled: false, policy: { state: "disabled" } }],
    });
    expect((await listModels(openaiConfig)).map((m) => m.id)).toEqual(["gpt-5"]);
  });
});

describe("gateway model routing", () => {
  const zen: ProviderConfig = {
    id: "opencode",
    name: "OpenCode Zen",
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "sk-test",
    createdAt: 0,
  };
  const go: ProviderConfig = {
    ...zen,
    id: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
  };

  it("routes Zen Claude models to Anthropic Messages one level up", async () => {
    const resolved = await resolveProviderModel({ ...zen, model: "claude-sonnet-5-5" });
    expect(resolved.shape).toBe("anthropic");
    expect(resolved.baseUrl).toBe("https://opencode.ai/zen");
  });

  it("routes Zen GPT models to Responses on the same base", async () => {
    for (const model of ["gpt-5.5", "gpt-5.3-codex-spark"]) {
      const resolved = await resolveProviderModel({ ...zen, model });
      expect(resolved.shape, model).toBe("responses");
      expect(resolved.baseUrl, model).toBe("https://opencode.ai/zen/v1");
    }
  });

  it("routes Zen Gemini models to Google's wire on the same base", async () => {
    const resolved = await resolveProviderModel({ ...zen, model: "gemini-3.8-flash" });
    expect(resolved.shape).toBe("gemini");
    expect(resolved.baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  it("leaves the Zen free shelf on the preset's chat completions", async () => {
    for (const model of ["big-pickle", "minimax-m3.1-flash-free", "glm-5.3-flash-free"]) {
      const resolved = await resolveProviderModel({ ...zen, model });
      expect(resolved.shape, model).toBe("openai");
      expect(resolved.baseUrl, model).toBe("https://opencode.ai/zen/v1");
    }
  });

  it("routes Go Muse to Responses, Qwen Max to Messages, and keeps GLM on completions", async () => {
    const muse = await resolveProviderModel({ ...go, model: "muse-spark-1.3-contributor" });
    expect(muse.shape).toBe("responses");
    expect(muse.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    const qwen = await resolveProviderModel({ ...go, model: "qwen3.8-max" });
    expect(qwen.shape).toBe("anthropic");
    expect(qwen.baseUrl).toBe("https://opencode.ai/zen/go");
    const glm = await resolveProviderModel({ ...go, model: "glm-5.3" });
    expect(glm.shape).toBe("openai");
    expect(glm.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  });

  it("never reroutes a non-gateway provider", async () => {
    const resolved = await resolveProviderModel({ ...openaiConfig, model: "gpt-5" });
    expect(resolved.shape).toBe("openai");
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
  });
});

describe("effort levels per model", () => {
  const anthropic: ProviderConfig = {
    id: "anthropic",
    name: "Anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    createdAt: 0,
  };
  const zen: ProviderConfig = {
    ...anthropic,
    id: "opencode",
    name: "OpenCode Zen",
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
  };

  it("offers every level to the adaptive Claude models and none to Haiku 4.5", () => {
    for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(effortLevels(anthropic, model), model).toEqual(REASONING_EFFORTS);
    }
    expect(effortLevels(anthropic, "claude-haiku-4-5-20251001")).toEqual([]);
    expect(effortLevels({ ...anthropic, id: "claude" }, "claude-haiku-4-5-20251001")).toEqual([]);
  });

  it("reads the wire a gateway routes the model to, not the preset's", () => {
    expect(effortLevels(zen, "claude-sonnet-5-5")).toEqual(REASONING_EFFORTS);
    expect(effortLevels(zen, "gpt-5.5")).toEqual(REASONING_EFFORTS);
    expect(effortLevels(zen, "big-pickle")).toEqual(REASONING_EFFORTS);
  });

  it("offers every level on other wires, and while the model is not known", () => {
    expect(effortLevels(openaiConfig, "gpt-5")).toEqual(REASONING_EFFORTS);
    expect(effortLevels(anthropic, undefined)).toEqual(REASONING_EFFORTS);
  });

  it("keeps a stored level only where the model takes it", () => {
    const high: ProviderConfig = { ...anthropic, reasoningEffort: "high" };
    expect(effectiveEffort(high, "claude-opus-5-5")).toBe("high");
    expect(effectiveEffort(high, "claude-haiku-4-5-20251001")).toBeUndefined();
  });

  it("runs at the model's default rather than sending a level it does not take", async () => {
    const haiku = await resolveProviderModel({
      ...anthropic,
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "high",
    });
    expect(haiku.reasoningEffort).toBeUndefined();
    const opus = await resolveProviderModel({
      ...anthropic,
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    expect(opus.reasoningEffort).toBe("high");
  });
});

describe("account and free model discovery", () => {
  const chatgpt: ProviderConfig = {
    ...openaiConfig,
    id: "chatgpt",
    name: "ChatGPT",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    auth: {
      accessToken: "account-models-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "account-1",
    },
  };
  const zen: ProviderConfig = {
    ...openaiConfig,
    id: "opencode",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "",
  };
  const catalog = {
    models: [
      { slug: "account-second", visibility: "list", priority: 2 },
      {
        slug: "account-first",
        display_name: "Account first",
        visibility: "list",
        priority: 1,
        supported_in_api: false,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
      { slug: "hidden", visibility: "hide", priority: 0 },
    ],
  };

  it("uses the account catalog and priority, not a static Responses shelf", async () => {
    const mock = stubFetch(200, catalog);
    await saveProvider(chatgpt);
    const models = await listStoredModels(chatgpt);
    expect(models.map((model) => model.id)).toEqual(["account-first", "account-second"]);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.0.0-test");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-models-token");
    expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("account-1");
    expect(knownModels(chatgpt)).toEqual(models);
    expect((await resolveProviderModel(chatgpt)).model).toBe("account-first");
    expect(mock.mock.calls.every(([, request]) => request?.method === "GET")).toBe(true);
  });

  it("validates pins against the account list without silently changing them", async () => {
    stubFetch(200, catalog);
    await saveProvider(chatgpt);
    await expect(resolveProviderModel({ ...chatgpt, model: "gpt-6-sol" })).rejects.toMatchObject({
      kind: "model",
      status: 400,
    });
    expect((await resolveProviderModel({ ...chatgpt, model: "account-second" })).model).toBe(
      "account-second",
    );
  });

  it("keeps empty and failed account lists distinct, with no static fallback", async () => {
    await saveProvider(chatgpt);
    stubFetch(200, { models: [] });
    await expect(resolveProviderModel(chatgpt)).rejects.toMatchObject({ kind: "model" });
    expect(knownModels(chatgpt)).toEqual([]);
    stubFetch(401, { error: "unauthorized" });
    await expect(resolveProviderModel(chatgpt)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });

  it("keeps account caches separate even when two accounts share a bearer", () => {
    const other: ProviderConfig = {
      ...chatgpt,
      auth: { ...chatgpt.auth!, chatgptAccountId: "account-2" },
    };
    writeModelsCache(modelsTarget(chatgpt), [{ id: "account-only" }]);
    expect(readModelsCache(modelsTarget(other))).toBeUndefined();
    expect(knownModels(other)).toEqual([]);
  });

  it("sends only account-supported effort without rewriting the stored choice", async () => {
    stubFetch(200, catalog);
    await saveProvider(chatgpt);
    const config: ProviderConfig = { ...chatgpt, model: "account-first", reasoningEffort: "max" };
    expect((await resolveProviderModel(config)).reasoningEffort).toBeUndefined();
    expect(config.reasoningEffort).toBe("max");
    expect(effortLevels(chatgpt, "account-first")).toEqual(["low", "high"]);
    expect(
      (await resolveProviderModel({ ...config, reasoningEffort: "high" })).reasoningEffort,
    ).toBe("high");
  });

  it("uses public access and never offers paid or decision-only Zen models", async () => {
    const mock = stubFetch(200, {
      data: [
        { id: "paid-newest", created: 999 },
        { id: "jev-1.13-free", created: 998 },
        { id: "big-pickle", created: 1 },
        { id: "deepseek-v4.1-flash-free", created: 2 },
      ],
    });
    expect((await listModels(zen)).map((model) => model.id)).toEqual([
      "big-pickle",
      "deepseek-v4.1-flash-free",
    ]);
    expect(new Headers(mock.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer public");
    const resolved = await resolveProviderModel(zen);
    expect(resolved.apiKey).toBe("public");
    expect(resolved.model).toBe("deepseek-v4.1-flash-free");
    await expect(resolveProviderModel({ ...zen, model: "paid-newest" })).rejects.toMatchObject({
      kind: "model",
    });
  });
});

describe("listModels for a backend with no list route", () => {
  it("returns nothing for Antigravity and never calls out: the preset is the list", async () => {
    const mock = stubFetch(200, {});
    const models = await listModels({
      id: "antigravity",
      shape: "gemini",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      apiKey: "at-1",
    });
    expect(models).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});
