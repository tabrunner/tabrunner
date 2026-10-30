import { beforeAll, describe, expect, it } from "vitest";

// Regression check for the pressed-state bug: the auto segment used "" as its
// value, which Base UI's Toggle drops out of group control — the picker opened
// with nothing active, and clicking auto stuck it locally pressed alongside a
// real locale. Non-empty sentinel values fix both halves; the mount-time
// assertion below fails the moment a segment falls out of group control again.
//
// test-setup's storage mock has a no-op watch (and locks localeItem to it by
// importing @/i18n first), so a pick can't round-trip into a re-render here —
// picks are asserted through the stored value instead.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n, localeItem } from "@/i18n";
import { LanguageToggle } from "../LanguageToggle";

// react-dom/client act opt-in (no testing-library in this repo).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// test-setup inits the shared instance but never registers it with
// react-i18next; without this useTranslation finds no instance.
beforeAll(() => setI18n(i18n));

async function renderToggle(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<LanguageToggle />));
  return { container, root };
}

async function unmount({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-pressed") === "true",
  );

const clickButton = (container: HTMLElement, label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
  });

describe("LanguageToggle", () => {
  it("opens with exactly the auto segment active by default", async () => {
    const view = await renderToggle();
    expect(view.container.querySelectorAll("button")).toHaveLength(4);
    const active = pressed(view.container);
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toBe("Auto");
    await unmount(view);
  });

  it("saves a picked locale", async () => {
    const view = await renderToggle();
    await clickButton(view.container, "PT");
    expect(await localeItem.get()).toBe("pt-BR");
    await unmount(view);
  });

  it("saves null when switching back to auto", async () => {
    // A stored locale mounts with that segment active, so the auto segment is
    // a genuine pick (clicking the active segment is a no-op by design).
    await localeItem.set("en");
    const view = await renderToggle();
    expect(pressed(view.container)[0]!.textContent).toBe("EN");
    await clickButton(view.container, "Auto");
    expect(await localeItem.get()).toBeNull();
    await unmount(view);
  });
});
