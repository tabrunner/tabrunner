import { describe, it, expect, vi } from "vitest";

/**
 * The build's own conditions, in a test.
 *
 * WXT imports the background entrypoint at build time to read its options, and
 * it does that under @webext-core/fake-browser — where every `chrome.debugger`
 * event throws "not implemented" the moment a listener is added. So a listener
 * registered at module scope in anything the background reaches is a build that
 * fails, and whether it fails today depends on how the analysis bundle
 * tree-shakes: it can sit dormant for weeks and then break on somebody else's
 * unrelated import. That is exactly how it broke on 2026-09-02.
 *
 * This stub is fake-browser's behaviour, narrowed to the two events that carry
 * the trap. Importing the modules IS the assertion.
 */
vi.mock("wxt/utils/storage", () => ({
  storage: {
    defineItem: (_key: string, opts?: { fallback?: unknown }) => ({
      getValue: async () => opts?.fallback ?? null,
      setValue: async () => {},
      removeValue: async () => {},
      watch: () => () => {},
    }),
  },
}));

const notImplemented = (chain: string) => ({
  addListener: () => {
    throw new Error(`${chain}.addListener not implemented`);
  },
});

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
  debugger: {
    onDetach: notImplemented("debugger.onDetach"),
    onEvent: notImplemented("debugger.onEvent"),
  },
};

describe("browser module scope", () => {
  it("registers no chrome.debugger listener at import", async () => {
    await expect(import("../cdp-driver")).resolves.toBeDefined();
    await expect(import("../inspect")).resolves.toBeDefined();
  });

  it("registers them once the driver attaches", async () => {
    const added: string[] = [];
    const chrome = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
    chrome.debugger = {
      onDetach: { addListener: () => added.push("onDetach") },
      onEvent: { addListener: () => added.push("onEvent") },
      attach: async () => {},
      sendCommand: async () => ({}),
    };
    const { ensureAttached } = await import("../cdp-driver");
    await ensureAttached(1);
    expect(added).toEqual(["onDetach", "onEvent"]);
  });
});
