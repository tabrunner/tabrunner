import { createWriteQueue, defineItem } from "@/lib/storage";
import { i18n } from "@/i18n";
import { hostMatches, normalizeHostList, scopeHostOf } from "@/lib/host";
import { validOutboundUrl } from "@/lib/url";
import { SLASH_COMMAND_NAMES } from "@/modules/conversation/command-names";
import { MAX_MCP_PER_SKILL, type Skill } from "./types";
import { isValidSkillName, MAX_BODY_CHARS, MAX_DESCRIPTION_CHARS, MAX_SKILLS } from "./types";

/** One flat array, read-modify-written whole — see the ponytail note in types.ts. */
export const skillsItem = defineItem<Skill[]>("skills", []);

// The options page, the import dialog and the draft dialog can all save.
const serialized = createWriteQueue();

export function listSkills(): Promise<Skill[]> {
  return skillsItem.get();
}

export function watchSkills(cb: (list: Skill[]) => void): () => void {
  return skillsItem.watch(cb);
}

export type SaveSkillResult = { ok: true; skill: Skill } | { ok: false; error: string };

/** What callers hand in — the store owns the clock (createdAt survives a replace). */
export type SkillInput = Omit<Skill, "createdAt" | "updatedAt">;

/**
 * Stores a new skill, or replaces one by id. Every rule lives here rather than
 * at the call sites, so the editor, the import preview and the draft dialog
 * cannot each carry their own version of a limit — and a name can never be
 * held by two records.
 */
export function saveSkill(input: SkillInput): Promise<SaveSkillResult> {
  return serialized(async () => {
    if (!isValidSkillName(input.name)) {
      return { ok: false, error: i18n.t("skills.errors.badName") };
    }
    // Built-in slash commands keep their names — an enabled skill named like
    // one would never surface in the menu.
    if (SLASH_COMMAND_NAMES.includes(input.name)) {
      return { ok: false, error: i18n.t("skills.errors.reservedName") };
    }
    if (!input.description.trim()) {
      return { ok: false, error: i18n.t("skills.errors.noDescription") };
    }
    if (!input.body.trim()) {
      return { ok: false, error: i18n.t("skills.errors.noBody") };
    }
    if (input.description.length > MAX_DESCRIPTION_CHARS) {
      return {
        ok: false,
        error: i18n.t("skills.errors.descriptionTooLong", { max: MAX_DESCRIPTION_CHARS }),
      };
    }
    if (input.body.length > MAX_BODY_CHARS) {
      return { ok: false, error: i18n.t("skills.errors.bodyTooLong", { max: MAX_BODY_CHARS }) };
    }
    const list = await skillsItem.get();
    if (list.some((s) => s.id !== input.id && s.name === input.name)) {
      return { ok: false, error: i18n.t("skills.errors.nameTaken", { name: input.name }) };
    }
    const existing = list.findIndex((s) => s.id === input.id);
    const current = list[existing];
    if (!current && list.length >= MAX_SKILLS) {
      return { ok: false, error: i18n.t("skills.errors.tooMany", { max: MAX_SKILLS }) };
    }
    // Sites are stored normalized or not at all — hostMatches assumes it, and
    // callers that want to report unusable entries check before saving. MCP
    // refs validate like sites: garbage rows drop quietly here because the
    // INSTALL consent dialog is where a bad row gets its reckoning.
    const { sites: rawSites, mcpServers: rawMcp, ...rest } = input;
    const sites = normalizeHostList(rawSites ?? []).hosts;
    const mcpServers = (rawMcp ?? [])
      .filter((s) => s.name.trim() !== "" && validOutboundUrl(s.url))
      .slice(0, MAX_MCP_PER_SKILL);
    const skill: Skill = {
      ...rest,
      ...(sites.length > 0 ? { sites } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      createdAt: current?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    const next = current ? list.with(existing, skill) : [...list, skill];
    await skillsItem.set(next);
    return { ok: true, skill };
  });
}

/** Removes a skill. False when it was already gone — the caller's cue not to lie about it. */
export function deleteSkill(id: string): Promise<boolean> {
  return serialized(async () => {
    const list = await skillsItem.get();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    await skillsItem.set(next);
    return true;
  });
}

export function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  return serialized(async () => {
    const list = await skillsItem.get();
    const i = list.findIndex((s) => s.id === id);
    const current = list[i];
    if (!current) return;
    await skillsItem.set(list.with(i, { ...current, enabled, updatedAt: Date.now() }));
  });
}

/** The run-start snapshot — resolved once, like AGENTS.md/MEMORY.md. */
export interface RunSkills {
  /**
   * Every enabled skill. The `skill` tool resolves against this, so a skill
   * the user names outright (`/skill pay-rent` from another site) still loads
   * — site scoping is discovery, not a boundary — and mid-run edits never
   * rewrite a live run.
   */
  all: Skill[];
  /** What the system prompt lists: unsited skills, plus those matching the run's start site. */
  applicable: Skill[];
}

export async function loadSkillsForRun(url?: string): Promise<RunSkills> {
  const host = scopeHostOf(url);
  const all = (await skillsItem.get()).filter((s) => s.enabled);
  const applicable = all.filter(
    (s) => !s.sites?.length || (host !== null && s.sites.some((site) => hostMatches(site, host))),
  );
  return { all, applicable };
}
