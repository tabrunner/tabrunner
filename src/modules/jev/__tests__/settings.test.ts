import { afterEach, describe, expect, it, vi } from "vitest";
import { saveProvider, removeProvider } from "@/modules/providers/storage";
import { defineItem } from "@/lib/storage";
import {
  addJevSpend,
  jevForRun,
  jevSettingsItem,
  normalizeJevSettings,
  removeJevKey,
  saveJevKey,
  setActiveJev,
  setJevEnabled,
} from "../settings";

const okReply = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13-free",
      answers: {
        ok: { type: "choice", choice: "YES", probabilities: { YES: 1, NO: 0 } },
      },
      usage: { input_tokens: 40, output_tokens: 0 },
    }),
    { status: 200 },
  );

afterEach(async () => {
  vi.unstubAllGlobals();
  await removeJevKey();
  await removeProvider("opencode");
  await removeProvider("openrouter");
});

describe("jev settings", () => {
  it("migrates a legacy single-host record on read", async () => {
    const legacy = defineItem<unknown>("jev", null);
    await legacy.set({
      host: "typesafe",
      apiKey: "ts-123456",
      enabled: true,
      spent: 0.012,
    });

    const loaded = await jevSettingsItem.get();
    expect(loaded).toEqual({
      enabled: true,
      activeId: "typesafe",
      entries: [
        {
          id: "typesafe",
          host: "typesafe",
          apiKey: "ts-123456",
          spent: 0.012,
        },
      ],
    });
    expect(await jevForRun()).toEqual({ host: "typesafe", apiKey: "ts-123456" });
  });

  it("saves multiple Jev options, switches the active one, and falls back when removing the active entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okReply()),
    );

    await saveJevKey({ host: "opencode", model: "jev-1.13-free" });
    await saveJevKey({ host: "typesafe", apiKey: "ts-key-1" });
    await addJevSpend(0.05);

    let saved = await jevSettingsItem.get();
    expect(saved?.activeId).toBe("typesafe");
    expect(saved?.entries.map((e) => e.id)).toEqual(["opencode/jev-1.13-free", "typesafe"]);
    expect(saved?.entries.find((e) => e.id === "typesafe")?.spent).toBeCloseTo(0.05);

    await setActiveJev("opencode/jev-1.13-free");
    expect(await jevForRun()).toEqual({ host: "opencode", model: "jev-1.13-free" });

    await removeJevKey("opencode/jev-1.13-free");
    saved = await jevSettingsItem.get();
    expect(saved?.activeId).toBe("typesafe");
    expect(saved?.entries.map((e) => e.id)).toEqual(["typesafe"]);

    await setJevEnabled(false);
    expect(await jevForRun()).toBeNull();
  });

  it("reuses the configured OpenCode Zen provider credential when no Jev-specific key is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okReply()),
    );
    await saveProvider({
      id: "opencode",
      name: "OpenCode Zen",
      shape: "openai",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "oc-zen-secret",
      createdAt: 0,
    });

    await saveJevKey({ host: "opencode", model: "jev-1.13" });
    expect(await jevForRun()).toEqual({
      host: "opencode",
      model: "jev-1.13",
      apiKey: "oc-zen-secret",
    });

    expect(normalizeJevSettings(null)).toBeNull();
  });
});
