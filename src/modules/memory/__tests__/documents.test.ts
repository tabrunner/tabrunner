import { describe, it, expect } from "vitest";

// Storage stand-in (reset between tests) and i18n come from src/test-setup.ts.

import {
  remember,
  getDoc,
  setDoc,
  memoryEnabled,
  loadAgentContext,
  listMemory,
  removeMemory,
} from "../documents";
import { buildSystemPrompt, buildToolDefs } from "@/modules/agent/prompt";

describe("remember", () => {
  it("keeps facts written by overlapping runs", async () => {
    await Promise.all([
      remember("The billing page opens on the current month.", "acme.com"),
      remember("Invoices download from the billing page.", "acme.com"),
      remember("The user prefers PDF invoices."),
    ]);
    const doc = await getDoc("MEMORY.md");
    expect(doc).toContain("The billing page opens on the current month.");
    expect(doc).toContain("Invoices download from the billing page.");
    expect(doc).toContain("The user prefers PDF invoices.");
  });

  it("orders a removal and a new fact without losing either change", async () => {
    await remember("An outdated fact.");
    await Promise.all([removeMemory("An outdated fact."), remember("A new fact.")]);
    expect(await getDoc("MEMORY.md")).toBe("- A new fact.\n");
  });

  it("appends one bullet per fact", async () => {
    await remember("The user's work account is me@acme.com.");
    await remember("Invoices live at billing.acme.com.");
    expect(await getDoc("MEMORY.md")).toBe(
      "- The user's work account is me@acme.com.\n- Invoices live at billing.acme.com.\n",
    );
  });

  it("normalizes what the model sends — bullets, padding, stray newlines", async () => {
    await remember("  - The\n  user prefers metric units.  ");
    expect(await getDoc("MEMORY.md")).toBe("- The user prefers metric units.\n");
  });

  it("ignores a fact it already knows, whatever the casing", async () => {
    await remember("Login is the email link, not SSO.");
    await remember("login is the EMAIL link, not sso.");
    expect(await getDoc("MEMORY.md")).toBe("- Login is the email link, not SSO.\n");
  });

  it("rejects an empty fact instead of writing a bare bullet", async () => {
    expect(await remember("   ")).toBeNull();
    expect(await getDoc("MEMORY.md")).toBe("");
  });

  it("evicts oldest entries past the cap but always keeps the newest", async () => {
    await setDoc("MEMORY.md", `- ${"x".repeat(3_990)}\n- an older fact\n`);
    await remember("the newest fact");
    const doc = await getDoc("MEMORY.md");
    expect(doc).toContain("- the newest fact");
    expect(doc).not.toContain("xxx");
    expect(doc.length).toBeLessThanOrEqual(4_001);
  });
});

describe("remember with a site", () => {
  it("files the fact under its site's section, created on first use", async () => {
    await remember("The user's handle is gus.");
    await remember("Archive is the box icon, not the trash.", "mail.google.com");
    await remember("Login is the email link.", "acme.com");
    expect(await getDoc("MEMORY.md")).toBe(
      "- The user's handle is gus.\n" +
        "## site: mail.google.com\n- Archive is the box icon, not the trash.\n" +
        "## site: acme.com\n- Login is the email link.\n",
    );
  });

  it("normalizes the site on write — www, case, even a full URL", async () => {
    await remember("Login is the email link.", "https://WWW.Acme.COM/billing");
    expect(await getDoc("MEMORY.md")).toBe("## site: acme.com\n- Login is the email link.\n");
  });

  it("falls back to global rather than losing a fact to an unusable site", async () => {
    await remember("A fact worth keeping.", "not a host!");
    expect(await getDoc("MEMORY.md")).toBe("- A fact worth keeping.\n");
  });

  it("dedupes within the scope only — the same lesson may hold globally and on one site", async () => {
    await remember("Prefer the email login.");
    await remember("Prefer the email login.", "acme.com");
    await remember("prefer the EMAIL login.", "acme.com");
    expect(await getDoc("MEMORY.md")).toBe(
      "- Prefer the email login.\n## site: acme.com\n- Prefer the email login.\n",
    );
  });

  it("evicts only within the overfull scope — other scopes keep their facts", async () => {
    await setDoc(
      "MEMORY.md",
      `- a global fact\n## site: acme.com\n- ${"x".repeat(3_990)}\n## site: other.com\n- an untouched fact\n`,
    );
    await remember("the newest acme fact", "acme.com");
    const doc = await getDoc("MEMORY.md");
    expect(doc).toContain("- a global fact");
    expect(doc).toContain("- an untouched fact");
    expect(doc).toContain("- the newest acme fact");
    expect(doc).not.toContain("xxx");
  });
});

describe("listMemory", () => {
  it("returns stored facts with the bullet marker stripped, skipping blank lines", () => {
    expect(listMemory("- one\n\n- two\n")).toEqual([{ facts: ["one", "two"] }]);
    expect(listMemory("")).toEqual([]);
  });

  it("groups each section's facts under its site — a flat legacy doc is one global group", () => {
    expect(listMemory("- global\n## site: acme.com\n- scoped\n")).toEqual([
      { facts: ["global"] },
      { site: "acme.com", facts: ["scoped"] },
    ]);
    expect(listMemory("- one\n- two\n")).toEqual([{ facts: ["one", "two"] }]);
  });
});

describe("removeMemory", () => {
  it("removes the matching fact and keeps the rest", async () => {
    await setDoc("MEMORY.md", "- one\n- two\n- three\n");
    await removeMemory("two");
    expect(await getDoc("MEMORY.md")).toBe("- one\n- three\n");
  });

  it("leaves the doc empty when the last fact goes", async () => {
    await setDoc("MEMORY.md", "- one\n");
    await removeMemory("one");
    expect(await getDoc("MEMORY.md")).toBe("");
  });

  it("is a no-op for a fact that is not there", async () => {
    await setDoc("MEMORY.md", "- one\n");
    await removeMemory("missing");
    expect(await getDoc("MEMORY.md")).toBe("- one\n");
  });

  it("removes only within the given scope — the twin in the other scope survives", async () => {
    await setDoc("MEMORY.md", "- shared\n## site: acme.com\n- shared\n");
    await removeMemory("shared", "acme.com");
    expect(await getDoc("MEMORY.md")).toBe("- shared\n");
  });

  it("drops a section's heading with its last fact", async () => {
    await setDoc("MEMORY.md", "- global\n## site: acme.com\n- only one\n");
    await removeMemory("only one", "acme.com");
    expect(await getDoc("MEMORY.md")).toBe("- global\n");
  });
});

describe("loadAgentContext", () => {
  it("loads both docs and offers the remember tool when memory is on", async () => {
    await setDoc("AGENTS.md", "Always confirm before paying.");
    await remember("The user's handle is gus.");

    const ctx = await loadAgentContext();
    expect(ctx.memoryOn).toBe(true);

    const prompt = buildSystemPrompt(ctx, "English");
    expect(prompt).toContain("Always confirm before paying.");
    expect(prompt).toContain("- The user's handle is gus.");
    expect(buildToolDefs(ctx.memoryOn).map((t) => t.name)).toContain("remember");
  });

  it("keeps instructions but drops memory and the tool when memory is off", async () => {
    await setDoc("AGENTS.md", "Always confirm before paying.");
    await remember("The user's handle is gus.");
    await memoryEnabled.set(false);

    const ctx = await loadAgentContext();
    const prompt = buildSystemPrompt(ctx, "English");
    expect(prompt).toContain("Always confirm before paying.");
    expect(prompt).not.toContain("MEMORY.md");
    expect(prompt).not.toContain("gus");
    expect(buildToolDefs(ctx.memoryOn).map((t) => t.name)).not.toContain("remember");
  });

  it("still announces MEMORY.md while it is empty — an unmentioned file is never written to", async () => {
    const prompt = buildSystemPrompt(await loadAgentContext(), "English");
    expect(prompt).toContain("# MEMORY.md");
    expect(prompt).toContain("(empty");
    expect(prompt).not.toContain("# AGENTS.md");
  });

  it("names the user's language for the plan steps and the done summary", async () => {
    const prompt = buildSystemPrompt(await loadAgentContext(), "Português (Brasil)");
    expect(prompt).toContain("Português (Brasil)");
  });

  it("loads the starting site's sections — heading included — and drops the rest", async () => {
    await setDoc(
      "AGENTS.md",
      "Always confirm before paying.\n## site: google.com\nUse the work account.\n## site: jira.acme.com\nLog under PROJ-1.\n",
    );
    await setDoc(
      "MEMORY.md",
      "- A global fact.\n## site: google.com\n- Archive is the box icon.\n## site: jira.acme.com\n- Sprint board opens filtered.\n",
    );

    const ctx = await loadAgentContext("https://mail.google.com/mail/u/0/");
    expect(ctx.instructions).toContain("Always confirm before paying.");
    expect(ctx.instructions).toContain("## site: google.com");
    expect(ctx.instructions).toContain("Use the work account.");
    expect(ctx.instructions).not.toContain("jira");
    expect(ctx.memory).toContain("- A global fact.");
    expect(ctx.memory).toContain("- Archive is the box icon.");
    expect(ctx.memory).not.toContain("Sprint board");
  });

  it("keeps the user's own headings global — only site: headings scope", async () => {
    await setDoc(
      "AGENTS.md",
      "## site: acme.com\nUse SSO.\n## My other notes\nAlways reply politely.\n",
    );
    const ctx = await loadAgentContext("https://unrelated.example.com/");
    expect(ctx.instructions).not.toContain("Use SSO.");
    expect(ctx.instructions).toContain("## My other notes");
    expect(ctx.instructions).toContain("Always reply politely.");
  });

  it("loads global content only when the run has no site — chrome://, or no URL at all", async () => {
    await setDoc("MEMORY.md", "- A global fact.\n## site: acme.com\n- A scoped fact.\n");
    for (const url of ["chrome://extensions", undefined]) {
      const ctx = await loadAgentContext(url);
      expect(ctx.memory).toContain("A global fact.");
      expect(ctx.memory).not.toContain("A scoped fact.");
    }
  });
});
