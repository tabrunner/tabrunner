import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential, SignInPrompt } from "@providerkit/core/auth";
import type { Select } from "@/components/Select";
import { i18n } from "@/i18n";
import { ProviderForm } from "../ui/ProviderForm";
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
        <option key={option.value} value={option.value}>
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
  it("saves fresh Zen free access without an account or completion probe", async () => {
    const onSaved = vi.fn();
    await render({ onSaved });
    await chooseProvider("opencode");
    expect(container.textContent).toContain("API key (optional)");
    expect(container.textContent).toContain("without an account");
    await act(async () => button("Use free models").click());
    expect(await getProvider("opencode")).toMatchObject({ apiKey: "public" });
    expect((await getProvider("opencode"))?.auth).toBeUndefined();
    expect(checkCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "opencode", apiKey: "public" }),
      expect.any(AbortSignal),
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith("opencode");
  });

  it("keeps an account on a blank-key update, but switches to an explicitly pasted key", async () => {
    const zen: ProviderConfig = {
      id: "opencode",
      name: "OpenCode Zen",
      shape: "openai",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "",
      auth: {
        accessToken: "account-token",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
      },
      model: "big-pickle",
      reasoningEffort: "high",
      createdAt: 0,
    };
    useProvidersStore.setState({ providers: [zen], activeId: zen.id });
    await render({ initialProvider: zen });
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(await getProvider("opencode")).toMatchObject({ auth: zen.auth, model: zen.model });
    expect(checkCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "account-token", auth: zen.auth }),
      expect.any(AbortSignal),
    );
    const input = container.querySelector('input[type="password"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "oc_new_key",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const stored = await getProvider("opencode");
    expect(stored?.apiKey).toBe("oc_new_key");
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

  it("keeps an existing Zen connection selected with its account and key paths", async () => {
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
    expect(container.querySelector("select")?.value).toBe("opencode");
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(button("Sign in with OpenCode Zen")).toBeDefined();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(useProvidersStore.getState().activeId).toBe("opencode");
    expect(useProvidersStore.getState().providers[0]?.model).toBe("big-pickle");
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
