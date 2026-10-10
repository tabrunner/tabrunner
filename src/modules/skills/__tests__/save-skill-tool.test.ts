import { describe, it, expect, vi, afterEach } from "vitest";
import { handleSaveSkill } from "../save-skill-tool";
import { listSkills } from "../store";
import { isValidSkillName } from "../types";

const DOC = `---
name: invoice-download
description: Pulls the latest invoice PDF from the billing portal
sites: [acme.com]
aliases: [bills, get-invoices]
tags: [billing, "monthly invoices"]
mcp_servers:
  - name: billing-mcp
    url: https://mcp.example.com
---

# Invoice download

1. Open the billing page.`;

describe("handleSaveSkill", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a URL through the shared pipeline and stores it enabled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(DOC)));
    const result = await handleSaveSkill({ url: "acme/billing-skill" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.saved.name).toBe("invoice-download");
      expect(result.saved.description).toContain("billing portal");
    }
    const stored = (await listSkills()).find((s) => s.name === "invoice-download");
    expect(stored?.enabled).toBe(true);
    expect(stored?.body).toContain("Open the billing page.");
    expect(stored?.source?.url).toContain("raw.githubusercontent.com");
    expect(stored?.aliases).toEqual(["bills", "get-invoices"]);
    expect(stored?.tags).toEqual(["billing", "monthly invoices"]);
    expect(stored?.sites).toEqual(["acme.com"]);
    expect(stored?.mcpServers).toEqual([{ name: "billing-mcp", url: "https://mcp.example.com" }]);
  });

  it("keeps command metadata with overrides and returns useful alias failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Response(DOC)),
    );
    const result = await handleSaveSkill({
      url: "https://example.com/SKILL.md",
      name: "monthly-billing",
      sites: ["billing.example.com"],
    });
    expect(result.ok).toBe(true);
    const stored = (await listSkills())[0];
    expect(stored?.name).toBe("monthly-billing");
    expect(stored?.aliases).toEqual(["bills", "get-invoices"]);
    expect(stored?.tags).toEqual(["billing", "monthly invoices"]);
    expect(stored?.sites).toEqual(["billing.example.com"]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Response(DOC.replace("bills, get-invoices", "help"))),
    );
    const rejected = await handleSaveSkill({ url: "https://example.com/other.md", name: "other" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("/help");
    expect(await listSkills()).toHaveLength(1);
  });

  it("a name override covers files whose frontmatter names nothing usable", async () => {
    // Fresh Responses per call — a mockedResolved single body consumes once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Response("just steps, no frontmatter")),
    );
    const unnamed = await handleSaveSkill({ url: "https://example.com/notes.md" });
    expect(unnamed.ok).toBe(false);
    const named = await handleSaveSkill({ url: "https://example.com/notes.md", name: "My Notes" });
    expect(named.ok).toBe(true);
  });

  it("never overwrites — an existing name comes back as the store's own error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          (input: RequestInfo | URL) =>
            new Response(
              String(input).includes("billing-skill")
                ? DOC
                : "---\nname: other\ndescription: x\n---\nbody",
            ),
        ),
    );
    await handleSaveSkill({ url: "acme/billing-skill" });
    const second = await handleSaveSkill({
      url: "https://example.com/other.md",
      name: "invoice-download",
    });
    expect(second.ok).toBe(false);
    // ...and nothing landed under a shadow id.
    expect((await listSkills()).filter((s) => s.name === "invoice-download")).toHaveLength(1);
  });

  it("rejects non-https inputs before any fetch happens", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(handleSaveSkill({ url: "http://example.com/SKILL.md" })).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a valid name in the store's grammar — sanity on the override path", async () => {
    expect(isValidSkillName("my-notes")).toBe(true);
    expect(isValidSkillName("My Notes")).toBe(false); // normalizeSkillName folded it earlier
  });
});
