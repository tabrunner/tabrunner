/**
 * A skill is a named, reusable instruction recipe — what a `## site:` section
 * of AGENTS.md can't be: listed by description, loaded on demand, invoked by
 * name (`/skill <name>`), imported and exported as SKILL.md markdown. Storage
 * is this structured record; the markdown is only the interchange form
 * (`skill-md.ts`), the same split the schedule module uses for cron-like text.
 */
/**
 * An MCP server a skill carries in its interchange form (`mcp_servers:` in
 * SKILL.md). Reference only — ids, enabled flags and timestamps are minted at
 * INSTALL time in the MCP registry, so disabling or deleting the skill never
 * touches an installed server.
 */
export interface SkillMcpRef {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface Skill {
  /** Stable identity for store ops and React keys — `name` is the model-facing one. */
  id: string;
  /** Kebab-case identity, unique across the store: what the catalog lists and the tool loads. */
  name: string;
  /** What it does and when to use it — a skill with no description is invisible to the model. */
  description: string;
  /** Normalized hosts (lib/host rules). Absent or empty = offered on every site. */
  sites?: string[];
  /** The instructions themselves, markdown prose. Never executed, only read by the model. */
  body: string;
  /** Off = kept but never offered, listed, or loadable. */
  enabled: boolean;
  /** Where an imported skill came from — provenance shown in the editor. */
  source?: { url: string };
  /** Servers this skill SUGGESTS installing at import time — consent is per import. */
  mcpServers?: SkillMcpRef[];
  createdAt: number;
  updatedAt: number;
}

/**
 * ponytail: fixed caps, one flat array read-modify-written whole (store.ts) —
 * tens of small records, not thousands. Ceilings: 50 skills, 20k-char bodies,
 * 500-char descriptions; a bigger library means one key per skill plus an
 * index, exactly the conversations upgrade path.
 */
export const MAX_SKILLS = 50;
export const MAX_BODY_CHARS = 20_000;
export const MAX_DESCRIPTION_CHARS = 500;

/** ponytail: one skill suggesting more than three servers is a bundle, not a
 *  recipe — the upgrade path is importing real bundles as a unit. */
export const MAX_MCP_PER_SKILL = 3;

/**
 * What a description is once it reaches the run: a single catalog line. The
 * prompt truncates listings at this, and the distiller is told to write under
 * it — one number so the two can't drift.
 */
export const MAX_CATALOG_DESC_CHARS = 250;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  // "new" is reserved: /skill new is the create subcommand, so a skill named
  // "new" could never be invoked.
  return NAME_RE.test(name) && name !== "new";
}

/**
 * Best-effort kebab form of whatever a file, a model, or a user typed as a
 * name. Null when nothing usable survives — the caller's cue to ask for one.
 */
export function normalizeSkillName(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return isValidSkillName(name) ? name : null;
}
