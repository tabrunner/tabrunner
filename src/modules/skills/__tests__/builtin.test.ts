import { describe, it, expect } from "vitest";
import { seedBuiltinSkills, BUILTIN_SKILL_URL } from "../builtin";
import { deleteSkill, listSkills } from "../store";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const record = () => listSkills().then((s) => s.find((x) => x.id === "builtin-tabrunner-help"));

describe("seedBuiltinSkills", () => {
  it("install seeds it enabled and loadable like any skill", async () => {
    await seedBuiltinSkills("install");
    const seeded = await record();
    expect(seeded?.name).toBe("tabrunner-help");
    expect(seeded?.enabled).toBe(true);
    expect(seeded?.source?.url).toBe(BUILTIN_SKILL_URL);
    expect(seeded?.body).toContain("# TabRunner help");
  });

  it("update refreshes the shipped words but never overrides the user's toggle", async () => {
    await seedBuiltinSkills("install");
    const store = await import("../store");
    // The user switched it off and rewrote its words after installing.
    await store.setSkillEnabled("builtin-tabrunner-help", false);
    const current = (await record())!;
    await store.saveSkill({
      ...current,
      id: current.id,
      description: "user's own wording",
      body: "user's own body",
    });

    await seedBuiltinSkills("update");

    const after = await record();
    // Shipped doc wins on content; the toggle and creation time stay theirs.
    expect(after?.description).toContain("TabRunner itself");
    expect(after?.body).toContain("# TabRunner help");
    expect(after?.enabled).toBe(false);
    expect(after?.createdAt).toBe(current.createdAt);
  });

  it("deleting it sticks across updates — no tombstone state needed", async () => {
    await seedBuiltinSkills("install");
    await deleteSkill("builtin-tabrunner-help");
    await seedBuiltinSkills("update");
    expect(await record()).toBeUndefined();
  });
});
