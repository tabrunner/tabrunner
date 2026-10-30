import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { listSkills } from "../store";
import { ImportSkillDialog } from "../ui/ImportSkillDialog";

const { fetchMarkdown } = vi.hoisted(() => ({
  fetchMarkdown: vi.fn<(url: string) => Promise<string>>(),
}));
vi.mock("../import-url", () => ({
  resolveSkillSource: () => ({ ok: true, url: "https://example.com/first.md" }),
  resolveGithubRepo: () => ({ ok: true, repo: { owner: "example", repo: "skills" } }),
  discoverRepoSkills: async () => ({
    ok: true,
    files: [
      { path: "first/SKILL.md", url: "https://example.com/first.md" },
      { path: "second/SKILL.md", url: "https://example.com/second.md" },
    ],
    truncated: false,
  }),
  fetchSkillMarkdown: fetchMarkdown,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => setI18n(i18n));

let view: { root: Root; container: HTMLElement } | undefined;
afterEach(async () => {
  if (view) {
    await act(async () => view?.root.unmount());
    view.container.remove();
    view = undefined;
  }
  fetchMarkdown.mockReset();
});

async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

async function openBulkReview() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  view = { root, container };
  await act(async () => root.render(<ImportSkillDialog open onClose={() => {}} />));
  const label = [...document.querySelectorAll("label")].find(
    (label) => label.textContent === i18n.t("skills.import.url"),
  );
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing import URL field");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing input value setter");
  await act(async () => {
    setter.call(input, "example/skills");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(i18n.t("skills.import.fetch"));
}

function documentFor(name: string, alias: string, tag: string): string {
  return `---\nname: ${name}\ndescription: Downloads ${name}\naliases: [${alias}]\ntags: ["${tag}"]\n---\nOpen the billing page.`;
}

describe("bulk skill import metadata", () => {
  it("preserves each row's aliases and search words", async () => {
    fetchMarkdown.mockImplementation(async (url) =>
      url.includes("first")
        ? documentFor("invoice-download", "bills", "monthly invoices")
        : documentFor("receipt-download", "receipts", "monthly receipts"),
    );
    await openBulkReview();
    await click(i18n.t("skills.import.importSelected", { count: 2 }));
    const stored = await listSkills();
    expect(stored).toHaveLength(2);
    expect(stored[0]?.aliases).toEqual(["bills"]);
    expect(stored[0]?.tags).toEqual(["monthly invoices"]);
    expect(stored[1]?.aliases).toEqual(["receipts"]);
    expect(stored[1]?.tags).toEqual(["monthly receipts"]);
  });

  it("reports a colliding row instead of dropping its alias or overwriting the first skill", async () => {
    fetchMarkdown.mockImplementation(async (url) =>
      url.includes("first")
        ? documentFor("invoice-download", "bills", "monthly invoices")
        : documentFor("receipt-download", "bills", "monthly receipts"),
    );
    await openBulkReview();
    await click(i18n.t("skills.import.importSelected", { count: 2 }));
    expect(await listSkills()).toHaveLength(1);
    expect((await listSkills())[0]?.name).toBe("invoice-download");
    expect(document.body.textContent).toContain("/bills belongs to invoice-download");
  });
});
