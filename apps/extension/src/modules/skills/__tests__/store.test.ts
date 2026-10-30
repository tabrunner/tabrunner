import { describe, it, expect } from "vitest";
import {
  deleteSkill,
  listSkills,
  loadSkillsForRun,
  saveSkill,
  setSkillEnabled,
  skillsItem,
  upsertBuiltinSkill,
} from "../store";
import type { SkillInput } from "../store";
import { RESERVED_SLASH_NAMES } from "@/modules/conversation/command-names";
import { MAX_SKILL_ALIASES, MAX_SKILL_TAG_CHARS, MAX_SKILL_TAGS, MAX_SKILLS } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

function input(name: string, overrides: Partial<SkillInput> = {}): SkillInput {
  return {
    id: `id-${name}`,
    name,
    description: `does ${name}`,
    body: `steps for ${name}`,
    enabled: true,
    ...overrides,
  };
}

async function seed(...inputs: SkillInput[]): Promise<void> {
  for (const s of inputs) {
    const result = await saveSkill(s);
    expect(result.ok).toBe(true);
  }
}

describe("saveSkill", () => {
  it("rejects a second record with the same name, but replaces by id keeping createdAt", async () => {
    await seed(input("pay-rent"));
    const taken = await saveSkill(input("pay-rent", { id: "other" }));
    expect(taken.ok).toBe(false);

    const first = (await listSkills())[0];
    const replaced = await saveSkill(input("pay-rent", { description: "v2" }));
    expect(replaced.ok && replaced.skill.createdAt).toBe(first?.createdAt);
    expect((await listSkills()).length).toBe(1);
  });

  it("enforces the grammar rules: name shape, reserved name, required prose", async () => {
    expect((await saveSkill(input("Pay Rent"))).ok).toBe(false);
    expect((await saveSkill(input("new"))).ok).toBe(false);
    expect((await saveSkill(input("a", { description: "  " }))).ok).toBe(false);
    expect((await saveSkill(input("a", { body: "" }))).ok).toBe(false);
  });

  it("rejects a name claimed by a built-in slash command — the menu must show the real one", async () => {
    expect((await saveSkill(input("usage"))).ok).toBe(false);
    // A near-miss stays legal.
    expect((await saveSkill(input("usage-report"))).ok).toBe(true);
  });

  it("reserves built-in names and aliases for both skill names and other command names", async () => {
    for (const name of RESERVED_SLASH_NAMES) {
      expect((await saveSkill(input(name))).ok, name).toBe(false);
      expect((await saveSkill(input("invoice-download", { aliases: [name] }))).ok, name).toBe(
        false,
      );
    }
  });

  it("normalizes aliases but rejects invalid, repeated and self-referencing names", async () => {
    const saved = await saveSkill(
      input("invoice-download", { aliases: [" Bills ", "GET-INVOICES"] }),
    );
    expect(saved.ok && saved.skill.aliases).toEqual(["bills", "get-invoices"]);
    for (const aliases of [
      ["invalid name"],
      ["bad/name"],
      [""],
      ["invoice-download"],
      ["Bills", " bills "],
    ]) {
      const result = await saveSkill(input("invoice-download", { aliases }));
      expect(result.ok, aliases.join(", ")).toBe(false);
      if (!result.ok) expect(result.error).not.toMatch(/^skills\.errors\./);
    }
    expect((await listSkills())[0]?.aliases).toEqual(["bills", "get-invoices"]);
  });

  it("protects every skill's canonical name and aliases, including disabled records", async () => {
    await seed(input("invoice-download", { aliases: ["bills"], enabled: false }));
    expect((await saveSkill(input("bills"))).ok).toBe(false);
    expect((await saveSkill(input("other", { aliases: ["invoice-download"] }))).ok).toBe(false);
    expect((await saveSkill(input("other", { aliases: ["bills"] }))).ok).toBe(false);
    // A record may keep its own aliases on edit, or make an old alias its name.
    expect(
      (await saveSkill(input("invoice-download", { aliases: ["bills"], description: "edited" })))
        .ok,
    ).toBe(true);
    expect(
      (
        await saveSkill(
          input("bills", { id: "id-invoice-download", aliases: ["invoice-download"] }),
        )
      ).ok,
    ).toBe(true);
  });

  it("lets old records keep an unchanged canonical name after a built-in claims it", async () => {
    const legacy = { ...input("quota"), createdAt: 1, updatedAt: 1 };
    await skillsItem.set([legacy]);
    const edited = await saveSkill(input("quota", { description: "edited" }));
    expect(edited.ok).toBe(true);
    expect(edited.ok && edited.skill.createdAt).toBe(1);
    expect((await saveSkill(input("other", { id: "id-quota", name: "limits" }))).ok).toBe(false);
    expect((await saveSkill(input("other", { aliases: ["quota"] }))).ok).toBe(false);
  });

  it("trims and dedupes bounded search phrases without reserving them as commands", async () => {
    const result = await saveSkill(
      input("invoice-download", {
        aliases: [],
        tags: [" Finance ", "finance", "monthly invoices", "help", ""],
      }),
    );
    expect(result.ok && result.skill.tags).toEqual(["finance", "monthly invoices", "help"]);
    expect(result.ok && result.skill.aliases).toEqual([]);
    expect((await saveSkill(input("finance"))).ok).toBe(true);
    expect(
      (await saveSkill(input("other", { tags: ["x".repeat(MAX_SKILL_TAG_CHARS + 1)] }))).ok,
    ).toBe(false);
    expect((await saveSkill(input("other", { tags: ["two\nlines"] }))).ok).toBe(false);
    expect(
      (
        await saveSkill(
          input("other", {
            tags: Array.from({ length: MAX_SKILL_TAGS + 1 }, (_, i) => `tag ${i}`),
          }),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await saveSkill(
          input("other", {
            aliases: Array.from({ length: MAX_SKILL_ALIASES + 1 }, (_, i) => `alias-${i}`),
          }),
        )
      ).ok,
    ).toBe(false);
  });

  it("does not add metadata to old records and retains explicit clears across builtin refresh", async () => {
    const old = await saveSkill(input("old"));
    expect(old.ok && old.skill.aliases).toBeUndefined();
    expect(old.ok && old.skill.tags).toBeUndefined();
    const builtin = {
      ...input("builtin-guide", { aliases: ["guide"], tags: ["setup"] }),
      createdAt: 0,
      updatedAt: 0,
    };
    await upsertBuiltinSkill(builtin);
    await saveSkill(input("builtin-guide", { aliases: [], tags: [] }));
    await upsertBuiltinSkill({ ...builtin, body: "new shipped instructions" });
    const refreshed = (await listSkills()).find((skill) => skill.name === "builtin-guide");
    expect(refreshed?.aliases).toEqual([]);
    expect(refreshed?.tags).toEqual([]);
    expect(refreshed?.body).toBe("new shipped instructions");
  });

  it("stores suggested MCP refs only for well-formed rows", async () => {
    const result = await saveSkill(
      input("mcp-skill", {
        mcpServers: [
          { name: "good", url: "https://mcp.example.com" },
          { name: "bad-url", url: "ftp://nope" },
          { name: "  ", url: "https://also-bad.example.com" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const stored = (await listSkills()).find((s) => s.name === "mcp-skill");
    expect(stored?.mcpServers?.map((s) => s.name)).toEqual(["good"]);
  });

  it("normalizes sites itself — hostMatches assumes stored hosts", async () => {
    const saved = await saveSkill(
      input("normed", { sites: [" WWW.Acme.com ", "acme.com", "not a host"] }),
    );
    expect(saved.ok && saved.skill.sites).toEqual(["acme.com"]);
  });

  it("caps the library at MAX_SKILLS for new records, edits still allowed", async () => {
    await seed(...Array.from({ length: MAX_SKILLS }, (_, i) => input(`s${i}`)));
    expect((await saveSkill(input("one-more"))).ok).toBe(false);
    expect((await saveSkill(input("s0", { description: "edited" }))).ok).toBe(true);
  });
});

describe("loadSkillsForRun", () => {
  it("scopes the catalog by start site, memory's exact rules", async () => {
    await seed(
      input("everywhere"),
      input("google-only", { sites: ["google.com"] }),
      input("acme-only", { sites: ["acme.com"] }),
    );
    const gmail = await loadSkillsForRun("https://mail.google.com/inbox");
    expect(gmail.applicable.map((s) => s.name)).toEqual(["everywhere", "google-only"]);
    // The tool's lookup table still holds every enabled skill.
    expect(gmail.all.map((s) => s.name)).toEqual(["everywhere", "google-only", "acme-only"]);

    const near = await loadSkillsForRun("https://notgoogle.com/");
    expect(near.applicable.map((s) => s.name)).toEqual(["everywhere"]);
  });

  it("gives restricted pages only the unsited skills, and skips disabled ones everywhere", async () => {
    await seed(input("everywhere"), input("sited", { sites: ["acme.com"] }));
    await setSkillEnabled("id-everywhere", false);
    const chrome = await loadSkillsForRun("chrome://extensions");
    expect(chrome.applicable.map((s) => s.name)).toEqual([]);
    expect(chrome.all.map((s) => s.name)).toEqual(["sited"]);
  });

  it("deleteSkill reports whether anything was actually removed", async () => {
    await seed(input("gone"));
    expect(await deleteSkill("id-gone")).toBe(true);
    expect(await deleteSkill("id-gone")).toBe(false);
  });
});
