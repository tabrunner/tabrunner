import { afterEach, describe, expect, it, vi } from "vitest";

const appStarted = vi.hoisted(() => vi.fn());
vi.mock("../main", () => {
  appStarted();
  return {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("side panel shell", () => {
  it("starts the app only after the page's first load is done", async () => {
    vi.useFakeTimers();
    await import("../shell");
    await vi.runAllTimersAsync();
    // Chromium shows the panel when the load finishes — anything started
    // before it keeps the panel hidden.
    expect(appStarted).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    expect(appStarted).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(appStarted).toHaveBeenCalledOnce());
  });
});
