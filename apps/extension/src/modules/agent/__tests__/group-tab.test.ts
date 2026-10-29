import { describe, it, expect, vi } from "vitest";
import { executeTool } from "../tools";
import type { RunGroup } from "../tools";
import type { BrowserDriver } from "@/modules/browser";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

// group_tab needs only the driver's grouping verb — everything else would
// pretend the tool touches the page, which it never does.
const driverWith = (groupTab: BrowserDriver["groupTab"]) =>
  ({ groupTab }) as unknown as BrowserDriver;

const runGroupWith = (
  groupId: number | undefined,
  file?: (tabId: number) => Promise<number | undefined>,
): RunGroup => ({
  groupId,
  touch: () => Promise.resolve(),
  file: file ?? ((tabId) => Promise.resolve(tabId)),
});

function groupTabCall(tabId: number) {
  return { id: "t1", name: "group_tab", args: { tab_id: tabId } };
}

const tabInfo = (tabId: number) => ({
  id: tabId,
  windowId: 10,
  title: "Docs",
  url: "https://docs.example",
  active: false,
});

describe("group_tab tool", () => {
  it("files the tab under the run's existing strip without minting", async () => {
    const groupTab = vi.fn(async (tabId: number) => tabInfo(tabId));
    const file = vi.fn();
    const result = await executeTool(groupTabCall(2), driverWith(groupTab), {
      runGroup: runGroupWith(7, file),
    });
    expect(groupTab).toHaveBeenCalledWith(2, 7);
    expect(file).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: tabInfo(2) });
  });

  it("mints the strip around the filed tab when the run has none yet", async () => {
    const groupTab = vi.fn(async (tabId: number) => tabInfo(tabId));
    const file = vi.fn(async () => 9);
    const result = await executeTool(groupTabCall(2), driverWith(groupTab), {
      runGroup: runGroupWith(undefined, file),
    });
    expect(file).toHaveBeenCalledWith(2);
    expect(groupTab).toHaveBeenCalledWith(2, 9);
    expect(result).toEqual({ ok: true, data: tabInfo(2) });
  });

  it("refuses under direct control, which has no run strip", async () => {
    const groupTab = vi.fn();
    const result = await executeTool(groupTabCall(2), driverWith(groupTab));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Could not add that tab to a group");
    expect(groupTab).not.toHaveBeenCalled();
  });

  it("declines when the strip couldn't be minted — the tab is likely gone", async () => {
    const groupTab = vi.fn();
    const result = await executeTool(groupTabCall(2), driverWith(groupTab), {
      runGroup: runGroupWith(undefined, async () => undefined),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Could not add that tab to a group");
    expect(groupTab).not.toHaveBeenCalled();
  });

  it("surfaces the driver's refusal as a tool error, not a crash", async () => {
    const groupTab = vi.fn(async () => {
      throw new Error("That tab is in another window");
    });
    const result = await executeTool(groupTabCall(2), driverWith(groupTab), {
      runGroup: runGroupWith(7),
    });
    expect(result).toEqual({ ok: false, error: "That tab is in another window" });
  });
});
