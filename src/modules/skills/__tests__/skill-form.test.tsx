import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { parseSkillMd } from "../skill-md";
import { listSkills, saveSkill } from "../store";
import { seedFromParsed, SkillForm, type SkillSeed } from "../ui/SkillForm";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => setI18n(i18n));

const views: { container: HTMLElement; root: Root }[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) {
    await act(async () => view.root.unmount());
    view.container.remove();
  }
});

async function renderForm(seed: SkillSeed, replaceOnCollision = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSaved = vi.fn();
  views.push({ container, root });
  await act(async () =>
    root.render(
      <SkillForm
        seed={seed}
        replaceOnCollision={replaceOnCollision}
        onSaved={onSaved}
        onCancel={() => {}}
      />,
    ),
  );
  return { container, onSaved };
}

function field(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find(
    (label) => label.textContent === labelText,
  );
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing field: ${labelText}`);
  return input;
}

async function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing input value setter");
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === i18n.t("skills.form.save"),
  );
  if (!button) throw new Error("Missing save button");
  await act(async () => button.click());
}

const DOC = `---
name: invoice-download
description: Downloads invoices
aliases: [bills, get-invoices]
tags: [billing, "receipts, invoices"]
mcp_servers:
  - name: billing-server
    url: https://mcp.example.com
---
Open the billing page.`;

describe("SkillForm command metadata", () => {
  it("preserves parsed import and draft metadata through the shared form", async () => {
    const seed = seedFromParsed(parseSkillMd(DOC), "https://example.com/SKILL.md");
    expect(seed.aliases).toEqual(["bills", "get-invoices"]);
    expect(seed.tags).toEqual(["billing", "receipts, invoices"]);
    const view = await renderForm(seed);
    await save(view.container);
    expect(view.onSaved).toHaveBeenCalledOnce();
    const stored = (await listSkills())[0];
    expect(stored?.aliases).toEqual(seed.aliases);
    expect(stored?.tags).toEqual(seed.tags);
    expect(stored?.mcpServers).toEqual(seed.mcpServers);
    expect(stored?.source?.url).toBe("https://example.com/SKILL.md");
  });

  it("keeps metadata on ordinary edits and records deliberate clears", async () => {
    const result = await saveSkill({
      ...seedFromParsed(parseSkillMd(DOC)),
      id: "invoice",
      name: "invoice-download",
      description: "Downloads invoices",
      body: "Open the billing page.",
      enabled: false,
    });
    if (!result.ok) throw new Error(result.error);
    const view = await renderForm(result.skill);
    await save(view.container);
    let stored = (await listSkills())[0];
    expect(stored?.aliases).toEqual(["bills", "get-invoices"]);
    expect(stored?.tags).toEqual(["billing", "receipts, invoices"]);
    expect(stored?.enabled).toBe(false);
    expect(stored?.createdAt).toBe(result.skill.createdAt);

    await type(field(view.container, i18n.t("skills.form.aliases")), "");
    await type(field(view.container, i18n.t("skills.form.tags")), "");
    await save(view.container);
    stored = (await listSkills())[0];
    expect(stored?.aliases).toEqual([]);
    expect(stored?.tags).toEqual([]);
    expect(stored?.mcpServers).toEqual(result.skill.mcpServers);
  });

  it("keeps existing metadata when a re-import has no metadata fields", async () => {
    await saveSkill({
      id: "invoice",
      name: "invoice-download",
      aliases: ["bills"],
      tags: ["monthly invoices"],
      description: "Downloads invoices",
      body: "Old steps",
      enabled: false,
    });
    const seed = seedFromParsed(
      parseSkillMd("---\nname: invoice-download\ndescription: Updated invoices\n---\nNew steps"),
    );
    const view = await renderForm(seed, true);
    expect(field(view.container, i18n.t("skills.form.aliases")).value).toBe("bills");
    await save(view.container);
    const stored = (await listSkills())[0];
    expect(stored?.id).toBe("invoice");
    expect(stored?.aliases).toEqual(["bills"]);
    expect(stored?.tags).toEqual(["monthly invoices"]);
    expect(stored?.body).toBe("New steps");
    expect(stored?.enabled).toBe(false);
  });

  it("shows alias errors without losing edits, then lets the person correct and save", async () => {
    const view = await renderForm(seedFromParsed(parseSkillMd(DOC)));
    const aliases = field(view.container, i18n.t("skills.form.aliases"));
    await type(aliases, "help");
    await save(view.container);
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("/help");
    expect(aliases.value).toBe("help");
    expect(await listSkills()).toHaveLength(0);
    await type(aliases, " Monthly-Bills ");
    await save(view.container);
    expect(view.onSaved).toHaveBeenCalledOnce();
    expect((await listSkills())[0]?.aliases).toEqual(["monthly-bills"]);
    expect((await listSkills())[0]?.tags).toEqual(["billing", "receipts, invoices"]);
  });
});
