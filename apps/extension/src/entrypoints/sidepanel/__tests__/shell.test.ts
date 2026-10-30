import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appStarted = vi.fn();

// The real cover, so the ids the shell reaches for are the ones that ship.
const html = readFileSync("src/entrypoints/sidepanel/index.html", "utf8");

beforeEach(() => {
  // A fresh shell and a fresh app per test: the shell arms its timers and its
  // load listener at import, and a test may swap the app for one that fails.
  vi.resetModules();
  vi.doMock("../main", () => {
    appStarted();
    return {};
  });
  vi.useFakeTimers();
  appStarted.mockReset();
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  const chromeStub = globalThis.chrome as unknown as Record<string, unknown>;
  chromeStub.i18n = { getMessage: (key: string) => `<${key}>` };
  vi.stubGlobal("reportError", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openPanel(): Promise<void> {
  await import("../shell");
  window.dispatchEvent(new Event("load"));
  await vi.advanceTimersByTimeAsync(0);
}

const boot = () => document.getElementById("boot")!;
const words = () =>
  [document.getElementById("boot-message")!, document.getElementById("boot-hint")!]
    .map((p) => p.textContent)
    .join(" ")
    .trim();
const retry = () => document.getElementById("boot-retry")!;

describe("side panel shell", () => {
  it("starts the app only after the page's first load is done", async () => {
    await import("../shell");
    await vi.advanceTimersByTimeAsync(1_000);
    // Chromium shows the panel when the load finishes — anything started
    // before it keeps the panel hidden.
    expect(appStarted).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    expect(appStarted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(appStarted).toHaveBeenCalledOnce());
  });

  it("says nothing on an open the app finishes", async () => {
    await openPanel();
    boot().classList.add("done"); // what App does once it has content
    await vi.advanceTimersByTimeAsync(20_000);
    expect(boot().dataset.state).toBeUndefined();
    expect(words()).toBe("");
    expect(retry().hidden).toBe(true);
  });

  it("speaks up on a slow open, then offers a way out", async () => {
    await openPanel();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(words()).toBe("<bootSlow>");
    expect(retry().hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(boot().dataset.state).toBe("stuck");
    expect(words()).toBe("<bootStuck> <bootStuckHint>");
    expect(retry().hidden).toBe(false);
    expect(retry().textContent).toBe("<bootRetry>");
  });

  it("says the load failed, and no later timer talks over it", async () => {
    vi.doMock("../main", () => {
      throw new Error("chunk missing");
    });
    await openPanel();
    await vi.waitFor(() => expect(boot().dataset.state).toBe("failed"));
    expect(words()).toBe("<bootFailed> <bootFailedHint>");
    expect(retry().hidden).toBe(false);
    expect(document.activeElement).toBe(retry());
    expect(reportError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(boot().dataset.state).toBe("failed");
    expect(words()).toBe("<bootFailed> <bootFailedHint>");
  });
});
