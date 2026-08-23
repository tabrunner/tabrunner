import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// The composer half of the slash commands: the menu opens and filters with the
// draft, Enter completes an arg-taking command instead of firing it, Enter on
// a full invocation runs it and clears the draft, and Esc dismisses without
// touching the text. The registry itself is covered in slash-commands.test.ts.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { ChatInput } from "../ui/ChatInput";
import { useConversationStore } from "../ui/store";
import { useProvidersStore } from "@/modules/providers/ui";
import type { ProviderConfig } from "@/modules/providers/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: the menu's keep-the-highlight-visible scroll is a noop here.
Element.prototype.scrollIntoView = function () {};

beforeAll(() => setI18n(i18n));

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "Anthropic",
  shape: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
  createdAt: 0,
};

interface Harness {
  container: HTMLElement;
  root: Root;
  area: HTMLTextAreaElement;
}

async function renderInput(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChatInput />));
  const area = container.querySelector("textarea");
  if (!area) throw new Error("no textarea");
  return { container, root, area };
}

async function unmount({ container, root }: Harness) {
  await act(async () => root.unmount());
  container.remove();
}

/** The draft lives in the store — set it there, the composer re-reads it. */
async function type(text: string) {
  await act(async () => useConversationStore.getState().setDraft(text));
}

async function press(area: HTMLTextAreaElement, key: string) {
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const menu = (h: Harness) => h.container.querySelector('[role="listbox"]');

beforeEach(() => {
  useProvidersStore.setState({ providers: [PROVIDER], activeId: "p1", loaded: true });
  useConversationStore.setState({
    messages: [],
    draft: "",
    pastedTexts: [],
    runTarget: "thisPage",
    status: "idle",
    queued: [],
    queuedRun: null,
    draftEngine: null,
    conversations: [],
    activeId: null,
  });
});

describe("ChatInput slash menu", () => {
  it("opens on '/' and filters with the fragment", async () => {
    const h = await renderInput();
    expect(menu(h)).toBeNull();
    await type("/");
    expect(menu(h)?.textContent).toContain("/background");
    await type("/eff");
    const box = menu(h);
    expect(box?.textContent).toContain("/effort");
    expect(box?.textContent).not.toContain("/background");
    await unmount(h);
  });

  it("completes an arg-taking command on Enter rather than firing it", async () => {
    const h = await renderInput();
    await type("/eff");
    await press(h.area, "Enter");
    expect(useConversationStore.getState().draft).toBe("/effort ");
    // …and the completed draft opens the candidate list (labels, not tokens).
    expect(menu(h)?.textContent).toContain("High");
    await unmount(h);
  });

  it("runs a full invocation on Enter and clears the composer", async () => {
    const h = await renderInput();
    await type("/effort h");
    await press(h.area, "Enter");
    const s = useConversationStore.getState();
    expect(s.draft).toBe("");
    const note = s.messages[s.messages.length - 1];
    expect(note?.role).toBe("step");
    expect(note?.content).toContain("→ high");
    await unmount(h);
  });

  it("dismisses on Esc without touching the draft, and stays shut until it changes", async () => {
    const h = await renderInput();
    await type("/mo");
    expect(menu(h)).not.toBeNull();
    await press(h.area, "Escape");
    expect(menu(h)).toBeNull();
    expect(useConversationStore.getState().draft).toBe("/mo");
    // The next edit reopens it.
    await type("/mod");
    expect(menu(h)).not.toBeNull();
    await unmount(h);
  });

  it("opens the picker on a bare command, current value highlighted, and picks with arrows", async () => {
    const h = await renderInput();
    await type("/effort");
    const box = menu(h);
    expect(box?.textContent).toContain("High");
    // The current value (default — nothing persisted) opens highlighted.
    const selected = box?.querySelector('[aria-selected="true"]');
    expect(selected?.textContent).toContain("Default");
    // Arrow down once (→ none) and Enter picks it.
    await press(h.area, "ArrowDown");
    await press(h.area, "Enter");
    const s = useConversationStore.getState();
    expect(s.draft).toBe("");
    expect(s.messages[s.messages.length - 1]?.content).toContain("→ none");
    await unmount(h);
  });

  it("Enter on an untouched picker is a no-op re-set of the current value", async () => {
    const h = await renderInput();
    await type("/effort");
    await press(h.area, "Enter");
    const s = useConversationStore.getState();
    expect(s.messages[s.messages.length - 1]?.content).toContain("→ default");
    await unmount(h);
  });

  it("picks a candidate on mouse down, not just on Enter", async () => {
    const h = await renderInput();
    await type("/effort");
    const row = [...(menu(h)?.querySelectorAll('[role="option"]') ?? [])].find((el) =>
      el.textContent?.includes("High"),
    );
    expect(row).toBeDefined();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    const s = useConversationStore.getState();
    expect(s.draft).toBe("");
    expect(s.messages[s.messages.length - 1]?.content).toContain("→ high");
    await unmount(h);
  });

  it("never shows the menu for plain tasks", async () => {
    const h = await renderInput();
    await type("book the flight /model");
    expect(menu(h)).toBeNull();
    await unmount(h);
  });
});
