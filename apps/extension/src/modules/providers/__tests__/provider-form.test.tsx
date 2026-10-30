import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential, SignInPrompt } from "@providerkit/core/auth";
import type { Select } from "@/components/Select";
import { i18n } from "@/i18n";
import { ProviderForm } from "../ui/ProviderForm";
import { AddProviderDialog } from "../ui/AddProviderDialog";
import { PRESETS } from "../presets";
import { useProvidersStore } from "../ui/store";
import { checkCredential } from "../models";
import type * as Models from "../models";
import { getProvider } from "../storage";
import type { ProviderConfig } from "../types";

type SelectProps = ComponentProps<typeof Select>;
const { signIn } = vi.hoisted(() => ({
  signIn:
    vi.fn<(signal: AbortSignal, prompt: (value: SignInPrompt) => void) => Promise<Credential>>(),
}));

vi.mock("../oauth-flows", () => ({
  authFlowFor: () => ({ signIn }),
  signInErrorMessage: (error: unknown) => String(error),
}));
vi.mock("../models", async (importOriginal) => ({
  ...(await importOriginal<typeof Models>()),
  checkCredential: vi.fn().mockResolvedValue({ rejected: false, models: [] }),
  writeModelsCache: vi.fn(),
}));
// Native select keeps these checks about the form; real Base UI behavior is checked in Chrome.
vi.mock("@/components/Select", () => ({
  Select: ({ label, value, onChange, options }: SelectProps) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          data-group={option.group}
        >
          {option.label} {option.hint}
        </option>
      ))}
    </select>
  ),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeAll(() => setI18n(i18n));
beforeEach(() => {
  useProvidersStore.setState({ providers: [], activeId: null, loaded: true });
  signIn.mockReset();
  signIn.mockImplementation(() => new Promise(() => {}));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: ComponentProps<typeof ProviderForm> = {}): Promise<void> {
  await act(async () => root.render(<ProviderForm {...props} />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function chooseProvider(id: string): Promise<void> {
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing provider select");
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("provider setup", () => {
  it("shows disabled Zen last with an unavailable label and keeps Go selectable", async () => {
    await render();
    const options = Array.from(container.querySelectorAll("option"));
    const zen = options.at(-1);
    expect(zen?.value).toBe("opencode");
    expect(zen?.disabled).toBe(true);
    expect(zen?.textContent).toContain("Unavailable");
    expect(zen?.getAttribute("data-group")).toBe("Unavailable");
    expect(
      container.querySelector<HTMLOptionElement>('option[value="opencode-go"]')?.disabled,
    ).toBe(false);
    expect(container.querySelector("select")?.value).toBe("antigravity");
  });

  it("keeps Zen free access available when its preset is re-enabled", async () => {
    const zen = PRESETS.find((preset) => preset.id === "opencode");
    if (!zen) throw new Error("Missing Zen preset");
    delete zen.disabled;
    try {
      const onSaved = vi.fn();
      await render({ onSaved });
      await chooseProvider(zen.id);
      expect(container.textContent).toContain("API key (optional)");
      expect(container.textContent).toContain("without an account");
      await act(async () => button("Use free models").click());
      expect(await getProvider(zen.id)).toMatchObject({ apiKey: "public" });
      expect((await getProvider(zen.id))?.auth).toBeUndefined();
      expect(checkCredential).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: zen.id, apiKey: "public" }),
        expect.any(AbortSignal),
      );
      expect(signIn).not.toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalledWith(zen.id);
    } finally {
      zen.disabled = true;
    }
  });

  it("keeps an account on a blank-key update, but switches to an explicitly pasted key", async () => {
    const account: ProviderConfig = {
      id: "openrouter",
      name: "OpenRouter",
      shape: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      auth: {
        accessToken: "account-token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
      },
      model: "openai/gpt-5",
      reasoningEffort: "high",
      createdAt: 0,
    };
    useProvidersStore.setState({ providers: [account], activeId: account.id });
    await render({ initialProvider: account });
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(await getProvider("openrouter")).toMatchObject({
      auth: account.auth,
      model: account.model,
    });
    expect(checkCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "account-token", auth: account.auth }),
      expect.any(AbortSignal),
    );
    const input = container.querySelector('input[type="password"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "sk-or-new-key",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const stored = await getProvider("openrouter");
    expect(stored?.apiKey).toBe("sk-or-new-key");
    expect(stored?.auth).toBeUndefined();
    expect(stored?.reasoningEffort).toBe("high");
  });

  it("starts with Antigravity's free quota and explains the account risk", async () => {
    await render();
    expect(container.querySelector("select")?.value).toBe("antigravity");
    expect(container.querySelector("option")?.textContent).toContain("Free quota");
    expect(container.querySelector('[role="note"]')?.textContent).toContain("suspended or closed");
    expect(container.textContent).toContain("free weekly usage");
    expect(container.textContent).not.toContain("Uses your Google Antigravity subscription");
    expect(
      container.querySelector('a[href="https://antigravity.google/docs/faq/"]'),
    ).not.toBeNull();
  });

  it("explains a disabled connection and starts new setup without editing its saved row", async () => {
    const zen: ProviderConfig = {
      id: "opencode",
      name: "OpenCode Zen",
      shape: "openai",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "test-key",
      model: "big-pickle",
      createdAt: 0,
    };
    useProvidersStore.setState({ providers: [zen], activeId: zen.id });
    await render({ initialProvider: zen });
    expect(container.querySelector("select")?.value).toBe("antigravity");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "OpenCode Zen is unavailable for chats",
    );
    expect(container.querySelector<HTMLOptionElement>('option[value="opencode"]')?.disabled).toBe(
      true,
    );
    expect(container.textContent).not.toContain("Sign in with OpenCode Zen");
    await chooseProvider("custom");
    expect(Array.from(container.querySelectorAll("input")).map((input) => input.value)).toEqual([
      "",
      "",
      "",
    ]);
    expect(button("Add provider")).toBeDefined();
    expect(useProvidersStore.getState().activeId).toBe(zen.id);
    expect(useProvidersStore.getState().providers).toEqual([zen]);
    expect(signIn).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<AddProviderDialog initialProvider={zen} open onOpenChange={() => {}} />),
    );
    const dialog = document.querySelector('[role="dialog"]');
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Choose another provider");
  });

  it("keeps Zen's account and key paths when its preset is re-enabled", async () => {
    const preset = PRESETS.find((provider) => provider.id === "opencode");
    if (!preset) throw new Error("Missing Zen preset");
    delete preset.disabled;
    try {
      const zen: ProviderConfig = {
        id: preset.id,
        name: preset.name,
        shape: preset.shape,
        baseUrl: preset.baseUrl,
        apiKey: "test-key",
        model: "big-pickle",
        createdAt: 0,
      };
      useProvidersStore.setState({ providers: [zen], activeId: zen.id });
      await render({ initialProvider: zen });
      expect(container.querySelector("select")?.value).toBe(zen.id);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(button("Sign in with OpenCode Zen")).toBeDefined();
      expect(container.textContent).toContain("Uses your OpenCode Zen account");
      expect(container.querySelector('input[type="password"]')).not.toBeNull();
      expect(useProvidersStore.getState().providers).toEqual([zen]);
    } finally {
      preset.disabled = true;
    }
  });

  it("cancels an old sign-in when the provider changes", async () => {
    await render();
    await act(async () => button("Sign in with Google Antigravity").click());
    const signal = signIn.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    await chooseProvider("chatgpt");
    expect(signal?.aborted).toBe(true);
    expect(button("Sign in with ChatGPT")).toBeDefined();
  });

  it("keeps the account warning visible while approval is pending", async () => {
    signIn.mockImplementation((_signal, prompt) => {
      prompt({ url: "https://accounts.google.com/test" });
      return new Promise(() => {});
    });
    await render();
    await act(async () => button("Sign in with Google Antigravity").click());
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.querySelector('[role="note"]')?.textContent).toContain("suspended or closed");
  });

  it("offers the Gemini key route without starting or saving a sign-in", async () => {
    await render();
    await act(async () => button("Use Gemini with an API key").click());
    expect(container.querySelector("select")?.value).toBe("gemini");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
    expect(useProvidersStore.getState().providers).toEqual([]);
  });
});
