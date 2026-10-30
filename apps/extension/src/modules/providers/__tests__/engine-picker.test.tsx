import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Popover } from "@/components/Popover";
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
vi.mock("../ui/AddProviderDialog", () => ({ AddProviderDialog: () => null }));

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

async function render(config: ProviderConfig): Promise<void> {
  await saveProvider(config);
  useProvidersStore.setState({ providers: [config], activeId: config.id, loaded: true });
  await act(async () => root.render(<EnginePicker provider={config} onPick={vi.fn()} />));
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
