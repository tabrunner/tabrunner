import { beforeAll, describe, expect, it } from "vitest";

// The model picker lists two rows with the identical model name — the auto
// choice and that same model pinned by hand — so the "Auto" chip is the only
// thing telling them apart, and it has to lead the label to be read in time.
// Trigger and popup each render the chip themselves; this pins both, because a
// fix applied to one copy and not the other looks correct until you open it.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { Select } from "../Select";
import type { SelectOption } from "../Select";

// react-dom/client act opt-in (no testing-library in this repo).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => setI18n(i18n));

const OPTIONS: SelectOption[] = [
  { value: "", label: "qwen3-max", hint: "Auto", hintLeading: true },
  { value: "qwen3-max", label: "qwen3-max" },
  { value: "k2", label: "k2", hint: "Not listed" },
];

async function renderSelect(value: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Select value={value} onChange={() => {}} options={OPTIONS} />),
  );
  return { container, root };
}

async function unmount({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

/** Reading order of the leaf text, space-joined — label and chip are separate
 *  elements spaced by CSS, so textContent alone runs them together. */
function readingOrder(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) {
    const part = walker.currentNode.textContent?.trim();
    if (part) parts.push(part);
  }
  return parts.join(" ");
}

describe("Select hint placement", () => {
  it("leads the trigger label with the chip", async () => {
    const view = await renderSelect("");
    expect(readingOrder(view.container.querySelector("button")!)).toContain("Auto qwen3-max");
    await unmount(view);
  });

  it("trails the trigger label without hintLeading", async () => {
    const view = await renderSelect("k2");
    expect(readingOrder(view.container.querySelector("button")!)).toContain("k2 Not listed");
    await unmount(view);
  });

  it("places both hints the same way inside the popup", async () => {
    const view = await renderSelect("");
    await act(async () => view.container.querySelector("button")!.click());
    // Base UI portals the popup out of the container, so read the option roles.
    const items = [...document.querySelectorAll('[role="option"]')].map(readingOrder);
    expect(items[0]).toContain("Auto qwen3-max");
    expect(items[2]).toContain("k2 Not listed");
    await unmount(view);
  });
});
