import { describe, it, expect } from "vitest";
import { newlyApplicableSkills } from "../activation";
import type { Skill } from "../types";

const skill = (name: string, sites?: string[]): Skill => ({
  id: name,
  name,
  description: `${name} desc`,
  ...(sites ? { sites } : {}),
  body: "",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});

describe("newlyApplicableSkills", () => {
  const all = [
    skill("global-recipe"),
    skill("gmail-triage", ["mail.google.com"]),
    skill("google-suite", ["google.com"]),
    skill("announced", ["gmail.com"]),
  ];
  const announced = new Set(["announced"]);

  it("matches scoped skills on the landed host, including subdomains", () => {
    const fresh = newlyApplicableSkills(all, "mail.google.com", announced);
    expect(fresh.map((s) => s.name).sort()).toEqual(["gmail-triage", "google-suite"]);
  });

  it("never re-lists unsited skills — they were cataloged at run start", () => {
    expect(newlyApplicableSkills(all, "example.com", announced)).toEqual([]);
  });

  it("each skill announces exactly once, even when another shares its host", () => {
    const first = newlyApplicableSkills(all, "mail.google.com", announced);
    for (const s of first) announced.add(s.name);
    expect(newlyApplicableSkills(all, "drive.google.com", announced)).toEqual([]);
  });

  it("a null host (restricted page) announces nothing", () => {
    expect(newlyApplicableSkills(all, null, new Set())).toEqual([]);
  });
});
