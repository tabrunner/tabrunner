import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { AddProviderDialog } from "../ui/AddProviderDialog";
import { ProviderList } from "../ui/ProviderList";
import { useProvidersStore } from "../ui/store";
import { getProvider, saveProvider } from "../storage";
import type { ProviderConfig } from "../types";

vi.mock("../ui/AddProviderDialog", () => ({
  AddProviderDialog: ({ trigger, initialProvider }: ComponentProps<typeof AddProviderDialog>) => (
    <div data-initial-provider={initialProvider?.id ?? "new"}>{trigger}</div>
  ),
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
});

const retired: ProviderConfig = {
  id: "opencode",
  name: "OpenCode Zen",
  shape: "openai",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "saved-key",
  auth: { accessToken: "saved-token", refreshToken: "refresh", expiresAt: 1 },
  model: "big-pickle",
  createdAt: 0,
};

async function render(providers: ProviderConfig[]): Promise<void> {
  for (const provider of providers) await saveProvider(provider);
  useProvidersStore.setState({ providers, activeId: retired.id, loaded: true });
  await act(async () => root.render(<ProviderList />));
}

describe("disabled provider row", () => {
  it("keeps saved credentials, offers new setup and removes only after confirmation", async () => {
    await render([retired]);
    const row = container.querySelector("li");
    expect(row?.textContent).toContain("OpenCode Zen");
    expect(row?.textContent).toContain("Unavailable");
    expect(row?.textContent).not.toContain("Active");
    expect(
      Array.from(row?.querySelectorAll("button") ?? []).map((button) => button.textContent),
    ).toEqual(["Choose another provider", "Remove"]);
    expect(
      row?.querySelector("[data-initial-provider]")?.getAttribute("data-initial-provider"),
    ).toBe("new");
    expect(await getProvider(retired.id)).toEqual(retired);
    const remove = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove",
    );
    if (!remove) throw new Error("Missing remove action");
    await act(async () => remove.click());
    expect(await getProvider(retired.id)).toEqual(retired);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Jev can no longer reuse it");
    expect(dialog?.textContent).not.toContain("add it again");
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Remove",
    );
    if (!confirm) throw new Error("Missing removal confirmation");
    await act(async () => confirm.click());
    expect(await getProvider(retired.id)).toBeUndefined();
  });

  it("shows the supported fallback as active instead of the saved retired default", async () => {
    const supported: ProviderConfig = {
      ...retired,
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    const missing: ProviderConfig = {
      ...supported,
      id: "custom-missing",
      name: "Needs a key",
      apiKey: "",
      auth: undefined,
    };
    await render([retired, supported, missing]);
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows[0]?.textContent).toContain("OpenRouterActive");
    expect(rows[1]?.textContent).toContain("Needs a key");
    expect(rows[2]?.textContent).toContain("OpenCode Zen");
    expect(rows[2]?.textContent).not.toContain("Active");
    expect(await getProvider(retired.id)).toEqual(retired);
  });
});
