import { describe, it, expect, vi, afterEach } from "vitest";
import { captureVisibleTab } from "../capture";

// A screenshot that fails for any reason used to say "restricted page", which
// sent people hunting for a chrome:// tab that was not there.
function stubCapture(capture: () => Promise<string>): void {
  vi.stubGlobal("chrome", {
    tabs: {
      query: () =>
        Promise.resolve([{ id: 7, windowId: 3, title: "Docs", url: "https://example.com/" }]),
      captureVisibleTab: capture,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("captureVisibleTab", () => {
  it("returns the image with the identity of the tab it caught", async () => {
    stubCapture(() => Promise.resolve("data:image/jpeg;base64,AA=="));
    await expect(captureVisibleTab()).resolves.toEqual({
      dataUrl: "data:image/jpeg;base64,AA==",
      tabId: 7,
      title: "Docs",
      url: "https://example.com/",
    });
  });

  it("calls a chrome:// refusal a restricted page", async () => {
    stubCapture(() =>
      Promise.reject(new Error('Cannot access contents of url "chrome://newtab/".')),
    );
    await expect(captureVisibleTab()).rejects.toThrow(/cannot read this page/);
  });

  it("names any other refusal instead of calling it a restricted page", async () => {
    stubCapture(() => Promise.reject(new Error("Failed to capture tab: image readback failed")));
    const failure = captureVisibleTab();
    await expect(failure).rejects.toThrow(/image readback failed/);
    await expect(failure).rejects.not.toThrow(/cannot read this page/);
  });
});
