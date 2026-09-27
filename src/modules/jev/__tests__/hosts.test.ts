import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_HOSTS, JEV_INPUT_PRICE } from "../hosts";
import { askJev } from "../client";
import { jevForRun, jevSettingsItem, saveJevKey, setJevEnabled } from "../settings";

const answers = { ok: { choice: "YES", probabilities: { YES: 0.9, NO: 0.1 } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JEV_HOSTS", () => {
  it("reads TypeSafe's reply and prices it from the token count", () => {
    const reply = JEV_HOSTS.typesafe.unwrap({
      model: "jev-latest",
      answers,
      usage: { input_tokens: 2000, output_tokens: 3 },
    });
    expect(reply).toEqual({ answers, inputTokens: 2000, cost: 2000 * JEV_INPUT_PRICE });
  });

  it("takes OpenRouter's own cost when it sends one", () => {
    const reply = JEV_HOSTS.openrouter.unwrap({
      answers,
      usage: { input_tokens: 2000, cost: 0.0005 },
    });
    expect(reply?.cost).toBe(0.0005);
  });

  it("unwraps Cloudflare's double envelope and refuses an unfinished task", () => {
    const done = {
      success: true,
      result: { status: "Completed", result: { answers, usage: { input_tokens: 10 } } },
    };
    expect(JEV_HOSTS.cloudflare.unwrap(done)?.answers).toEqual(answers);
    expect(JEV_HOSTS.cloudflare.unwrap({ success: true, result: { status: "Queued" } })).toBeNull();
    expect(JEV_HOSTS.cloudflare.unwrap({ success: false, errors: [] })).toBeNull();
    expect(JEV_HOSTS.cloudflare.url({ host: "cloudflare", apiKey: "k", accountId: "acc" })).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai/run",
    );
  });

  it("reads Vercel's camelCase usage and sends the gateway headers", () => {
    expect(JEV_HOSTS.vercel.unwrap({ answers, usage: { inputTokens: 7 } })?.inputTokens).toBe(7);
    expect(JEV_HOSTS.vercel.headers({ host: "vercel", apiKey: "k" })["ai-model-id"]).toBe(
      "typesafe-ai/jev",
    );
  });
});

describe("askJev", () => {
  it("waits out a 429 as Retry-After asks, then answers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }),
      )
      .mockResolvedValueOnce(Response.json({ answers, usage: { input_tokens: 5 } }));
    vi.stubGlobal("fetch", fetch);
    const reply = await askJev({ host: "typesafe", apiKey: "k" }, {}, {});
    expect(reply.answers).toEqual(answers);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails a rejected key at once, classified", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(askJev({ host: "typesafe", apiKey: "k" }, {}, {})).rejects.toMatchObject({
      kind: "auth",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("saveJevKey", () => {
  it("turns Jev on once the key checks out, and a run can then use it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] })));
    expect(await jevForRun()).toBeNull();
    await saveJevKey({ host: "typesafe", apiKey: "k" });
    expect(await jevSettingsItem.get()).toMatchObject({ enabled: true, spent: 0 });
    expect(await jevForRun()).toEqual({ host: "typesafe", apiKey: "k" });
    await setJevEnabled(false);
    expect(await jevForRun()).toBeNull();
  });

  it("saves nothing when the host rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(saveJevKey({ host: "typesafe", apiKey: "bad" })).rejects.toMatchObject({
      kind: "auth",
    });
    expect(await jevSettingsItem.get()).toBeNull();
  });
});
