import { describe, it, expect } from "vitest";
import { deleteSkill, listSkills, loadSkillsForRun, saveSkill, setSkillEnabled } from "../store";
import type { SkillInput } from "../store";
import { MAX_SKILLS } from "../types";

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
