import { describe, it, expect } from "vitest";
import type { ToolDef } from "@/modules/providers/types";
import { buildSystemPrompt, buildToolDefs } from "../prompt";
import { DURABLE_FACT_RULES, type AgentContext } from "@/modules/memory";
import type { Skill } from "@/modules/skills";

// i18n comes from src/test-setup.ts (vitest setupFiles).

const ctx: AgentContext = { instructions: "", memory: "", memoryOn: false };

describe("buildToolDefs", () => {
  it("hides the screenshot tool from a text-only model", () => {
    const names = buildToolDefs(false, false).map((t) => t.name);
    expect(names).toContain("snapshot");
    expect(names).not.toContain("screenshot");
  });

  it("offers the screenshot tool by default", () => {
    expect(buildToolDefs(false).map((t) => t.name)).toContain("screenshot");
  });
});

describe("buildSystemPrompt", () => {
  it("adds a text-only note when the model can't receive images", () => {
    const prompt = buildSystemPrompt(ctx, "English", false);
    expect(prompt).toContain("text-only");
    expect(prompt).toContain("no screenshot tool");
  });

  it("omits the note for image-capable models", () => {
    expect(buildSystemPrompt(ctx, "English")).not.toContain("text-only");
  });

  // Both in-run writing surfaces quote the one definition; the extraction prompt
  // is the third, checked in memory/__tests__/extract.test.ts. Restating the
  // criteria per surface is what let them drift into saving stale page readings.
  it("states MEMORY.md's admission rules once, on every surface that writes it", () => {
    expect(buildSystemPrompt({ ...ctx, memoryOn: true }, "English")).toContain(DURABLE_FACT_RULES);

    const remember = buildToolDefs(true).find((t) => t.name === "remember");
    expect(remember?.description).toContain(DURABLE_FACT_RULES);
  });

  it("withholds MEMORY.md and its rules when memory is off", () => {
    const prompt = buildSystemPrompt(ctx, "English");
    expect(prompt).not.toContain("MEMORY.md");
    expect(buildToolDefs(false).map((t) => t.name)).not.toContain("remember");
  });

  it("carries the operational rules the base prompt would otherwise never teach", () => {
    // Each guards a different real failure: an unverified submit, a frozen tab,
    // a retry loop, a stale ref, a hallucinated URL, and a CAPTCHA wall.
    // Losing one is a silent capability loss.
    const prompt = buildSystemPrompt(ctx, "English");
    expect(prompt).toMatch(/verify with a snapshot before you call done/i);
    expect(prompt).toMatch(/alert, confirm, prompt/i);
    expect(prompt).toMatch(/2–3 failures/i);
    expect(prompt).toMatch(/stale/i);
    expect(prompt).toMatch(/never guess a deep URL/i);
    expect(prompt).toMatch(/CAPTCHA/i);
  });

  it("frames page content as untrusted data, not instructions", () => {
    const prompt = buildSystemPrompt(ctx, "English");
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/never an instruction/i);
  });

  it("answers in the message's own language, with the app's as the fallback", () => {
    const prompt = buildSystemPrompt(ctx, "Portuguese");
    expect(prompt).toMatch(/language the user's message is written in/i);
    expect(prompt).toContain("takes Portuguese");
  });
});

describe("skills in the prompt and tool list", () => {
  const skill = (name: string, description = `does ${name}`): Skill => ({
    id: name,
    name,
    description,
    body: "steps",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  });

  it("emits the catalog only when something applies, one name: description line each", () => {
    expect(buildSystemPrompt(ctx, "English")).not.toContain("# Skills");
    const prompt = buildSystemPrompt(ctx, "English", true, [], [skill("pay-rent")]);
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("- pay-rent: does pay-rent");
  });

  it("flattens a multi-line description — one row per skill, no faked extra rows", () => {
    const prompt = buildSystemPrompt(ctx, "English", true, [], [skill("multi", "a\n\n# fake\nb")]);
    expect(prompt).toContain("- multi: a # fake b");
  });

  it("truncates a listing description — the tool loads the full body, the line is discovery", () => {
    const prompt = buildSystemPrompt(ctx, "English", true, [], [skill("wordy", "x".repeat(400))]);
    const line = prompt.split("\n").find((l) => l.startsWith("- wordy:")) ?? "";
    expect(line.length).toBeLessThanOrEqual("- wordy: ".length + 250);
    expect(line.endsWith("…")).toBe(true);
  });

  it("degrades to names-only past the catalog budget instead of eating the context", () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`s${i}`, "d".repeat(250)));
    const prompt = buildSystemPrompt(ctx, "English", true, [], many);
    expect(prompt).toContain("- s0\n");
    expect(prompt).not.toContain("- s0: ");
  });

  it("offers the skill tool only when enabled skills exist — REMEMBER_TOOL's rule", () => {
    expect(buildToolDefs(false, true, true).map((t) => t.name)).toContain("skill");
    expect(buildToolDefs(false, true, false).map((t) => t.name)).not.toContain("skill");
    expect(buildToolDefs(false, true).map((t) => t.name)).not.toContain("skill");
  });

  it("offers delegate only while Jev is on, ahead of any remote tools", () => {
    const remote: ToolDef = {
      name: "mcp__x__y",
      description: "",
      params: { type: "object", properties: {} },
    };
    const on = buildToolDefs(false, true, false, false, true, [remote]).map((t) => t.name);
    expect(on.slice(-2)).toEqual(["delegate", "mcp__x__y"]);
    expect(buildToolDefs(false, true, false, false, false).map((t) => t.name)).not.toContain(
      "delegate",
    );
  });

  it("tells the planner about Jev only while it is on — the section rides with the tool", () => {
    expect(buildSystemPrompt(ctx, "English")).not.toContain("# Jev");
    const prompt = buildSystemPrompt(ctx, "English", true, [], [], true);
    expect(prompt).toContain("# Jev");
    expect(prompt).toContain('"delegate"');
  });
});
