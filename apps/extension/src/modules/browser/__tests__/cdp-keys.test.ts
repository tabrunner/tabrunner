import { describe, it, expect, vi, beforeEach } from "vitest";

// @/i18n (pulled in via cdp-driver) reads wxt storage at module scope — no chrome in tests.
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

// The indicator and debugger are side channels; what matters here is which key
// events leave the driver.
vi.mock("../indicator", () => ({ refreshAgentIndicator: vi.fn(async () => {}) }));

interface KeyEvent {
  type: string;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}
const sent: { method: string; params: Record<string, unknown> }[] = [];
let platformOs = "mac";

(globalThis as Record<string, unknown>).chrome = {
  runtime: { getPlatformInfo: async () => ({ os: platformOs }) },
  tabs: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    get: async () => ({ id: 1 }),
  },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
    attach: async () => {},
    sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return {};
    },
  },
};

const { pressKey, resolveKey, resolveModifiers, resetPlatformModifierForTest, ensureAttached } =
  await import("../cdp-driver");

describe("resolveKey", () => {
  it("resolves named keys case-insensitively", () => {
    expect(resolveKey("Enter")).toMatchObject({ key: "Enter", vkc: 13 });
    expect(resolveKey("ESCAPE")).toMatchObject({ key: "Escape", vkc: 27 });
  });

  it("resolves any single character — the escape hatch the enum used to block", () => {
    expect(resolveKey("a")).toMatchObject({ key: "a", code: "KeyA", vkc: 65, text: "a" });
    expect(resolveKey("5")).toMatchObject({ key: "5", code: "Digit5", vkc: 53 });
    // Punctuation has no physical code — invented ones are worse than none.
    expect(resolveKey("!").code).toBe("");
  });

  it("rejects multi-character names that are neither named nor single characters", () => {
    expect(() => resolveKey("scrolllock")).toThrow(/Unsupported key/);
  });
});

describe("resolveModifiers", () => {
  beforeEach(() => {
    resetPlatformModifierForTest();
    platformOs = "mac";
  });

  it("maps Mod to Cmd on macOS and Ctrl elsewhere", async () => {
    expect(await resolveModifiers(["Mod"])).toBe(4);
    resetPlatformModifierForTest();
    platformOs = "linux";
    expect(await resolveModifiers(["Mod"])).toBe(2);
  });

  it("combines several modifiers into one bitmask and takes their aliases", async () => {
    expect(await resolveModifiers(["shift", "ctrl"])).toBe(2 + 8);
    expect(await resolveModifiers(["Command", "Shift"])).toBe(4 + 8);
    expect(await resolveModifiers(["option"])).toBe(1);
  });

  it("rejects an unknown modifier by name, with the supported list", async () => {
    await expect(resolveModifiers(["hyper"])).rejects.toThrow(/Unsupported modifier/);
  });
});

describe("pressKey", () => {
  beforeEach(async () => {
    sent.length = 0;
    resetPlatformModifierForTest();
    platformOs = "mac";
    await ensureAttached("keys", 1);
  });

  const keysOf = () =>
    sent
      .filter((s) => s.method === "Input.dispatchKeyEvent")
      .map((s) => s.params as unknown as KeyEvent);

  it("sends the character's text on a plain key press", async () => {
    await pressKey(1, "Escape");
    expect(keysOf()).toEqual([
      expect.objectContaining({ type: "keyDown", key: "Escape", modifiers: 0 }),
      expect.objectContaining({ type: "keyUp", key: "Escape", modifiers: 0 }),
    ]);
  });

  it("an accelerator chord carries no text — Mod+a selects, it does not type", async () => {
    await pressKey(1, "a", ["Mod"]);
    const [down] = keysOf();
    expect(down).toMatchObject({ type: "keyDown", key: "a", code: "KeyA", modifiers: 4 });
    expect(down?.text).toBeUndefined();
  });

  it("Shift alone IS typing — the character uppercases and keeps its text", async () => {
    await pressKey(1, "a", ["Shift"]);
    expect(keysOf()[0]).toMatchObject({ key: "A", modifiers: 8, text: "A" });
  });
});
