import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The gauge's whole contract is honesty: it never invents a denominator it
// wasn't given, it never blanks once a turn has been measured, and it never
// acts — clicking a measurement must not spend a model call.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { ContextGauge } from "../ui/ContextGauge";
import { useConversationStore } from "../ui/store";
import { useProvidersStore } from "@/modules/providers/ui";
import { writeModelsCache, modelsTarget } from "@/modules/providers/models";
import type { ProviderConfig } from "@/modules/providers/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => setI18n(i18n));

const PROVIDER = {
  id: "openrouter",
  name: "OpenRouter",
  shape: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  model: "gpt-5",
  createdAt: 0,
} as ProviderConfig;

async function render(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<ContextGauge />));
  return { container, root };
}

const gauge = (c: HTMLElement) => c.querySelector("span[role='status']");
const bar = (c: HTMLElement) => c.querySelector("span[aria-hidden] > span");

beforeEach(() => {
  // The models cache is module state, not storage — test-setup's reset misses
  // it, so a listed window would leak into the next case's "unknown" run.
  writeModelsCache(modelsTarget(PROVIDER), []);
  // No pinned provider — the gauge resolves the first one, the same rule the
  // header chip and the slash commands use.
  useProvidersStore.setState({ providers: [PROVIDER], activeId: null });
  useConversationStore.setState({
    contextTokens: 0,
    activeId: null,
    conversations: [],
    compact: vi.fn(),
  });
});

describe("the context gauge", () => {
  it("says nothing at all until a turn has been measured", async () => {
    const view = await render();
    expect(gauge(view.container)).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("shows the raw count and NO bar when the model's window is unknown", async () => {
    useConversationStore.setState({ contextTokens: 24_300 });
    const view = await render();
    // A percentage needs a denominator nobody gave us — the count stands alone.
    expect(gauge(view.container)?.textContent).toBe("24.3k context");
    expect(bar(view.container)).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("adds the ratio and the bar once the window is genuinely known", async () => {
    writeModelsCache(modelsTarget(PROVIDER), [{ id: "gpt-5", contextLength: 200_000 }]);
    useConversationStore.setState({ contextTokens: 50_000 });
    const view = await render();
    // 200k, not "200.0k": a round ceiling nobody measured to a hundred tokens.
    expect(gauge(view.container)?.textContent).toBe("50.0k / 200k");
    expect((bar(view.container) as HTMLElement).style.width).toBe("25%");
    await act(async () => view.root.unmount());
  });

  it("survives the run that measured it — a reopened panel reads the thread's own record", async () => {
    // Panel state is gone (contextTokens 0); the conversation's own record
    // stands in — and it is NOT inside lastRun, which the next message retires.
    useConversationStore.setState({
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          taskCount: 1,
          contextTokens: 31_200,
        },
      ],
    });
    const view = await render();
    // The LAST turn's input, never the cumulative sum of every turn.
    expect(gauge(view.container)?.textContent).toBe("31.2k context");
    await act(async () => view.root.unmount());
  });

  it("carries the thread's own spend, marked total so it can't read as the run's", async () => {
    useConversationStore.setState({
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          taskCount: 3,
          contextTokens: 31_200,
          spentTotal: 0.42,
        },
      ],
    });
    const view = await render();
    // The band one row up carries THIS run's cost; the word is what tells the
    // two dollar figures apart.
    expect(view.container.textContent).toContain("$0.42 total");
    await act(async () => view.root.unmount());
  });

  it("says nothing about money on a thread nothing priced — $0.00 would read as free", async () => {
    useConversationStore.setState({
      activeId: "c1",
      conversations: [
        { id: "c1", title: "t", createdAt: 0, updatedAt: 0, taskCount: 1, contextTokens: 31_200 },
      ],
    });
    const view = await render();
    expect(view.container.textContent).not.toContain("$");
    await act(async () => view.root.unmount());
  });

  it("is not a button — a measurement must not spend a model call on a stray click", async () => {
    useConversationStore.setState({ contextTokens: 24_300 });
    const view = await render();
    expect(view.container.querySelector("button")).toBeNull();
    await act(async () =>
      gauge(view.container)!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(useConversationStore.getState().compact).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });
});
