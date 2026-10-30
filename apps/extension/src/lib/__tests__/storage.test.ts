import { describe, it, expect, vi, beforeEach } from "vitest";
import { storage } from "wxt/utils/storage";
import { defineItem } from "../storage";

/**
 * The read coalescer. What matters is that a tick's reads leave as ONE call
 * and still answer with each item's own value — the panel's open is ten reads
 * that used to be ten round trips.
 */
describe("defineItem read batching", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("collapses one tick's reads into a single storage call", async () => {
    const spy = vi.spyOn(storage, "getItems");
    const name = defineItem("test:name", "anon");
    const count = defineItem("test:count", 0);
    await name.set("gus");

    const [a, b] = await Promise.all([name.get(), count.get()]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe("gus");
    // Untouched key falls back — the same rule getValue() applies.
    expect(b).toBe(0);
  });

  it("asks for a repeated key once and shares the answer", async () => {
    const spy = vi.spyOn(storage, "getItems");
    const pref = defineItem("test:pref", "system");

    const [a, b] = await Promise.all([pref.get(), pref.get()]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(1);
    expect(a).toBe("system");
    expect(b).toBe("system");
  });

  it("starts a fresh batch after the first one is on the wire", async () => {
    const spy = vi.spyOn(storage, "getItems");
    const pref = defineItem("test:pref", "system");

    await pref.get();
    await pref.get();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reads back what was just written", async () => {
    const item = defineItem("test:round-trip", { open: false });
    await item.set({ open: true });
    expect(await item.get()).toEqual({ open: true });
    await item.remove();
    expect(await item.get()).toEqual({ open: false });
  });
});
