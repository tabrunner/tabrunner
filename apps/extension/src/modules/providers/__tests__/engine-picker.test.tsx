import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Popover } from "@/components/Popover";
import type { AddProviderDialog } from "../ui/AddProviderDialog";
import { i18n } from "@/i18n";
import { modelsTarget, writeModelsCache } from "../models";
import { saveProvider } from "../storage";
import type { ProviderConfig } from "../types";
import { EnginePicker } from "../ui/EnginePicker";
import { useProvidersStore } from "../ui/store";

// These checks cover listing state; real popover and keyboard behavior are checked in Chrome.
vi.mock("@/components/Popover", () => ({
  Popover: ({ trigger, children }: ComponentProps<typeof Popover>) => (
    <section>
      {trigger}
      {children}
    </section>
  ),
}));
vi.mock("../ui/UsageSection", () => ({ UsageSection: () => null }));
vi.mock("../ui/AddProviderDialog", () => ({
  AddProviderDialog: ({ open }: ComponentProps<typeof AddProviderDialog>) =>
    open ? <div role="dialog">Add provider</div> : null,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => setI18n(i18n));
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function provider(token: string): ProviderConfig {
  return {
    id: "chatgpt",
    name: "ChatGPT",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    auth: { accessToken: token, refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 },
    createdAt: 0,
  };
}

async function render(
  config: ProviderConfig,
  providers = [config],
  onPick: ComponentProps<typeof EnginePicker>["onPick"] = vi.fn(),
): Promise<void> {
  await saveProvider(config);
  useProvidersStore.setState({ providers, activeId: config.id, loaded: true });
  await act(async () => root.render(<EnginePicker provider={config} onPick={onPick} />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function catalog(id: string): Response {
  return Response.json({ models: [{ slug: id, visibility: "list" }] });
}

describe("disabled chat provider", () => {
  const retired: ProviderConfig = {
    id: "opencode",
    name: "OpenCode Zen",
    shape: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "saved-key",
    model: "big-pickle",
    reasoningEffort: "high",
    createdAt: 0,
  };

  it("keeps the saved pin visible without fetching models and offers its one supported alternative", async () => {
    const alternative = provider("picker-alternative");
    const onPick = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await render(retired, [retired, alternative], onPick);
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "OpenCode Zen is unavailable for chats",
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("big-pickle");
    expect(container.textContent).not.toContain("Reasoning effort");
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(1);
    expect(onPick).not.toHaveBeenCalled();
    const tab = container.querySelector('button[aria-pressed="false"]');
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Missing alternative provider");
    expect(tab.title).toContain("ChatGPT");
    expect(tab.textContent).toBe("ChatGPT (Subscription)");
    await act(async () => tab.click());
    expect(onPick).toHaveBeenCalledWith({ providerId: alternative.id }, false);
    expect(useProvidersStore.getState().providers[0]).toEqual(retired);
  });

  it("offers adding a provider when no supported alternative is configured", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await render(retired);
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("Add a provider…").click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe("Add provider");
    expect(useProvidersStore.getState().providers).toEqual([retired]);
  });

  it("never offers Zen as a provider tab beside supported choices", async () => {
    const active = provider("picker-supported");
    writeModelsCache(modelsTarget(active), [{ id: "available-model" }]);
    const go: ProviderConfig = { ...retired, id: "opencode-go", name: "OpenCode Go" };
    await render(active, [retired, active, go]);
    const tabs = Array.from(container.querySelectorAll("button[aria-pressed]"));
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.getAttribute("title"))).toEqual([
      "ChatGPT (Subscription)",
      expect.stringContaining("OpenCode Go"),
    ]);
  });
});

describe("account model picker", () => {
  it("offers one explicit retry after failure without a loop or an unverified model", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 503 }))
      .mockResolvedValueOnce(catalog("account-model"));
    vi.stubGlobal("fetch", fetch);
    await render({ ...provider("picker-failed"), model: "saved-unverified" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("did not load");
    expect(container.textContent).not.toContain("is not listed");
    expect(container.querySelector("input")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => button("Refresh models").click());
    expect(button("account-model")).toBeDefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("saved-unverified, is not listed");
    expect(container.querySelector('button[title="saved-unverified"]')).toBeNull();
  });

  it("shows a pending refresh at once and keeps the old list when it fails", async () => {
    const config = provider("picker-refresh");
    writeModelsCache(modelsTarget(config), [{ id: "saved-model" }]);
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetch);
    await render(config);
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button("Refresh models").click());
    expect(button("Refreshing…").disabled).toBe(true);
    expect(button("saved-model")).toBeDefined();
    await act(async () => finish(Response.json({ error: "unavailable" }, { status: 503 })));
    expect(button("saved-model")).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("may be out of date");
    expect(button("Refresh models").disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an authoritative empty list from failure and offers refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [] })));
    await render({ ...provider("picker-empty"), model: "saved-unverified" });
    expect(container.textContent).not.toContain("Choose a model from this list");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("no usable models");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Refresh models")).toBeDefined();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("gpt-6-sol");
  });
});
