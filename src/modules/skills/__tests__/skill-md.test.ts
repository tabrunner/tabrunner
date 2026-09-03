import { describe, it, expect } from "vitest";
import { parseSkillMd, serializeSkillMd } from "../skill-md";
import type { Skill } from "../types";

describe("parseSkillMd", () => {
  it("imports a Claude Code SKILL.md — unknown keys reported, prose colons survive", () => {
    const parsed = parseSkillMd(`---
name: Invoice Download
description: Build for AWS: fetch the latest invoice PDF
allowed-tools:
  - Read
  - Bash(gh:*)
model: inherit
when_to_use: whenever invoices come up
---

# Invoice Download

1. Open the billing page.`);
    expect(parsed.name).toBe("invoice-download");
    expect(parsed.description).toBe("Build for AWS: fetch the latest invoice PDF");
    expect(parsed.ignoredKeys.sort()).toEqual(["allowed_tools", "model"]);
    expect(parsed.body).toContain("Open the billing page.");
  });

  it("reads site as a scalar, sites as inline or block lists, and reports junk", () => {
    expect(parseSkillMd(`---\nsite: www.Acme.com\n---\nbody`).sites).toEqual(["acme.com"]);
    const inline = parseSkillMd(`---\nsites: [acme.com, mail.google.com, not a host]\n---\nbody`);
    expect(inline.sites).toEqual(["acme.com", "mail.google.com"]);
    expect(inline.droppedSites).toEqual(["not a host"]);
    const block = parseSkillMd(`---\nsites:\n  - acme.com\n  - acme.com\n---\nbody`);
    expect(block.sites).toEqual(["acme.com"]);
  });

  it("uses when_to_use only when description is absent", () => {
    const fallback = parseSkillMd(`---\nname: a\nwhen_to_use: for x\n---\nbody`);
    expect(fallback.description).toBe("for x");
    const both = parseSkillMd(`---\nname: a\ndescription: real\nwhen_to_use: for x\n---\nbody`);
    expect(both.description).toBe("real");
  });

  it("treats a file with no frontmatter as pure body, deriving the name from its H1", () => {
    const parsed = parseSkillMd("# Pay Rent\n\nSteps here.");
    expect(parsed.name).toBe("pay-rent");
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe("# Pay Rent\n\nSteps here.");
  });

  it("never treats an unclosed opening rule as frontmatter", () => {
    const parsed = parseSkillMd("---\njust prose under a rule");
    expect(parsed.body).toContain("just prose under a rule");
    expect(parsed.ignoredKeys).toEqual([]);
  });
});

describe("serializeSkillMd", () => {
  const skill: Skill = {
    id: "1",
    name: "pay-rent",
    description: "Pays rent on the landlord portal: fees included",
    sites: ["acme.com", "pay.acme.com"],
    body: "1. Open the portal.\n2. Pay.",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };

  it("round-trips through parseSkillMd", () => {
    const parsed = parseSkillMd(serializeSkillMd(skill));
    expect(parsed.name).toBe(skill.name);
    expect(parsed.description).toBe(skill.description);
    expect(parsed.sites).toEqual(skill.sites);
    expect(parsed.body).toBe(skill.body);
    expect(parsed.ignoredKeys).toEqual([]);
  });

  it("omits the sites line for an everywhere skill and flattens newlines in the description", () => {
    const everywhere = { ...skill, description: "line one\nline two" };
    delete everywhere.sites;
    const text = serializeSkillMd(everywhere);
    expect(text).not.toContain("sites:");
    expect(text).toContain("description: line one line two");
  });

  it("round-trips servers the skill suggests installing", () => {
    const withMcp = {
      ...skill,
      mcpServers: [
        {
          name: "acme",
          url: "https://mcp.acme.com/mcp",
          headers: { Authorization: "Bearer xyz", "X-API-Key": "secret" },
        },
      ],
    };
    const text = serializeSkillMd(withMcp);
    expect(text).toContain("mcp_servers:");
    const parsed = parseSkillMd(text);
    expect(parsed.mcpServers).toEqual(withMcp.mcpServers);
    expect(parsed.droppedMcpServers).toEqual([]);
    expect(parsed.ignoredKeys).toEqual([]);
  });
});

describe("parseSkillMd — mcp_servers block", () => {
  it("reads name/url and repeated header rows, splitting each on the first =", () => {
    const parsed = parseSkillMd(`---
name: billing-run
description: Monthly billing
mcp_servers:
  - name: acme
    url: https://mcp.acme.com/mcp
    header: Authorization=Bearer xyz
    header: X-API-Key=k1
---
body`);
    expect(parsed.mcpServers).toEqual([
      {
        name: "acme",
        url: "https://mcp.acme.com/mcp",
        headers: { Authorization: "Bearer xyz", "X-API-Key": "k1" },
      },
    ]);
    expect(parsed.ignoredKeys).toEqual([]);
  });

  it("drops broken rows into the preview warning, without killing the file", () => {
    const parsed = parseSkillMd(`---
name: billing-run
description: d
mcp_servers:
  - name: no-url
    header: Authorization=x
  - url: https://ok.example.com/mcp
    header: =novalue
  - name: two-more
    url: https://a.example.com
  - name: three
    url: https://b.example.com
---
body`);
    // Malformed rows drop into the warning; the rest parse.
    expect(parsed.mcpServers.map((s) => s.name)).toEqual(["two-more", "three"]);
    expect(parsed.droppedMcpServers.sort()).toEqual(["no-url", "unnamed server"]);
    expect(parsed.body).toBe("body");
  });

  it("leaves a flat scalar list under mcp_servers out of the refs entirely", () => {
    const parsed = parseSkillMd(
      `---\nname: x\ndescription: d\nmcp_servers:\n  - not-a-map\n---\nb`,
    );
    expect(parsed.mcpServers).toEqual([]);
  });
});
