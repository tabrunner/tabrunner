import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The composer half of the paste fold: the first long paste of a draft becomes
// a [Pasted N lines] note, and every paste after it lands inline — the note is
// a surprise once, then it would just be in the way. paste-collapse.test.ts
// covers the pure token/expand math. The image half is here too: its encode is
// async, so its draft write must read the draft as it is when it lands.

/** Image encodes, held open so a paste can be caught mid-flight. */
const { encodes } = vi.hoisted(() => ({ encodes: [] as ((url: string) => void)[] }));
vi.mock("../ui/image", async (importOriginal) => ({
  ...(await importOriginal<typeof ImageModule>()),
  toAttachment: () => new Promise<string>((resolve) => encodes.push(resolve)),
}));

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import type * as ImageModule from "../ui/image";
import { ChatInput } from "../ui/ChatInput";
import { useConversationStore } from "../ui/store";
import { useProvidersStore } from "@/modules/providers/ui";
import type { ProviderConfig } from "@/modules/providers/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => setI18n(i18n));

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "Anthropic",
  shape: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
  createdAt: 0,
};

const LONG = "one\ntwo\nthree\nfour\nfive";

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

/**
 * A paste jsdom can carry: React reads `clipboardData` off the native event.
 * The returned event says whether the composer took the paste over
 * (`defaultPrevented`) or left it to the browser's own inline insert.
 */
async function dispatchPaste(
  area: HTMLTextAreaElement,
  clipboardData: { files: File[]; getData: () => string },
): Promise<Event> {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: clipboardData });
  await act(async () => {
    area.dispatchEvent(ev);
  });
  return ev;
}

const paste = (area: HTMLTextAreaElement, text: string) =>
  dispatchPaste(area, { files: [], getData: () => text });

/** An image paste; its encode stays open until `settle()`. */
const pasteImage = (area: HTMLTextAreaElement) =>
  dispatchPaste(area, {
    files: [new File([""], "shot.png", { type: "image/png" })],
    getData: () => "",
  });

/** Let every held encode finish, oldest first. */
async function settle() {
  await act(async () => {
    for (const resolve of encodes.splice(0)) resolve("data:image/jpeg;base64,zzz");
  });
}

/** The draft lives in the store — set it there, the composer re-reads it. */
async function type(text: string) {
  await act(async () => useConversationStore.getState().setDraft(text));
}

beforeEach(() => {
  encodes.length = 0;
  useProvidersStore.setState({ providers: [PROVIDER], activeId: "p1", loaded: true });
  useConversationStore.setState({
    messages: [],
    draft: "",
    pastedTexts: [],
    collapseDisabled: false,
    runMode: "foreground",
    status: "idle",
    queued: [],
    queuedRun: null,
    draftEngine: null,
    conversations: [],
    activeId: null,
  });
});

describe("ChatInput paste fold", () => {
  it("folds the first long paste, then lets the second through inline", async () => {
    const h = await renderInput();

    const first = await paste(h.area, LONG);
    expect(first.defaultPrevented).toBe(true);
    expect(useConversationStore.getState().draft).toBe("[Pasted 5 lines]");
    expect(useConversationStore.getState().pastedTexts).toEqual([
      { token: "[Pasted 5 lines]", content: LONG },
    ]);

    // Second one: the composer stays out of the way, so the browser inserts the
    // text itself — no new note, and nothing new held back for send.
    const second = await paste(h.area, LONG);
    expect(second.defaultPrevented).toBe(false);
    expect(useConversationStore.getState().pastedTexts).toHaveLength(1);
    expect(useConversationStore.getState().draft).toBe("[Pasted 5 lines]");

    await act(async () => h.root.unmount());
    h.container.remove();
  });

  it("a sent message re-arms the fold — the next draft folds again", async () => {
    const h = await renderInput();
    await paste(h.area, LONG);
    await act(async () => useConversationStore.getState().clearPastedTexts());
    await act(async () => useConversationStore.getState().setDraft(""));

    const again = await paste(h.area, LONG);
    expect(again.defaultPrevented).toBe(true);
    expect(useConversationStore.getState().draft).toBe("[Pasted 5 lines]");

    await act(async () => h.root.unmount());
    h.container.remove();
  });

  it("short pastes never fold and never disarm the fold", async () => {
    const h = await renderInput();

    const short = await paste(h.area, "just a line");
    expect(short.defaultPrevented).toBe(false);
    expect(useConversationStore.getState().collapseDisabled).toBe(false);

    const long = await paste(h.area, LONG);
    expect(long.defaultPrevented).toBe(true);

    await act(async () => h.root.unmount());
    h.container.remove();
  });
});

describe("ChatInput image paste", () => {
  it("keeps both tokens when a second image is pasted before the first encodes", async () => {
    const h = await renderInput();
    // Both handlers start from the same render, so both captured the same empty
    // draft. Whichever lands second must not write that stale draft back — the
    // token it would erase is the only thing that puts image #1 on the send.
    await pasteImage(h.area);
    await pasteImage(h.area);
    await settle();

    const draft = useConversationStore.getState().draft;
    expect(draft).toContain("[Image #1]");
    expect(draft).toContain("[Image #2]");

    await act(async () => h.root.unmount());
    h.container.remove();
  });

  it("does not swallow what was typed while the image encoded", async () => {
    const h = await renderInput();
    await pasteImage(h.area);
    await type("look at this");
    await settle();

    expect(useConversationStore.getState().draft).toBe("look at this [Image #1]");

    await act(async () => h.root.unmount());
    h.container.remove();
  });
});
