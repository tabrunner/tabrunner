import { describe, it, expect } from "vitest";
import { executeTool } from "../tools";
import type { BrowserDriver } from "@/modules/browser";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

// The full list is every tab the user has open, billing and inboxes included.
// A caller that knows what it wants asks for just that.
const tab = (id: number, title: string, url: string) => ({
  id,
  windowId: 1,
  title,
  url,
  active: false,
});
const tabs = [
  tab(1, "Inbox", "https://mail.example/u/0"),
  tab(2, "TabRunner docs", "https://tabrunner.app/docs"),
  tab(3, "Invoices", "https://billing.example/list"),
];
const driver = { listTabs: async () => tabs } as unknown as BrowserDriver;

async function listed(args: Record<string, unknown>): Promise<number[]> {
  const result = await executeTool({ id: "t", name: "list_tabs", args }, driver);
  const data = result.data as { tabs: Array<{ id: number }> };
  return data.tabs.map((t) => t.id);
}

describe("list_tabs query", () => {
  it("lists everything without one", async () => {
    expect(await listed({})).toEqual([1, 2, 3]);
  });

  it("keeps the tabs whose title or url contains it, ignoring case", async () => {
    expect(await listed({ query: "TABRUNNER" })).toEqual([2]);
    expect(await listed({ query: "billing.example" })).toEqual([3]);
  });

  it("an empty or blank query is no filter", async () => {
    expect(await listed({ query: "  " })).toEqual([1, 2, 3]);
  });

  it("a query that matches nothing returns an empty list, not everything", async () => {
    expect(await listed({ query: "zzz" })).toEqual([]);
  });
});
