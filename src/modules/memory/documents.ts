import { defineItem } from "@/lib/storage";
import { hostMatches, normalizeHost, scopeHostOf } from "@/lib/host";

/**
 * The two markdown documents TabRunner loads into every run, mirroring the
 * AGENTS.md / MEMORY.md convention coding agents settled on:
 *
 * - `AGENTS.md` is yours. Standing instructions that outlive any one task
 *   ("my work account is …", "always confirm before submitting a payment").
 * - `MEMORY.md` is the agent's. It writes durable facts there with the
 *   `remember` tool so the next run starts where the last one left off.
 *
 * Both docs share one scope axis: a `## site: <host>` heading opens a section
 * that loads only when the run starts on that site (suffix match, so
 * `google.com` covers `mail.google.com`). Everything else — content before any
 * such heading, and under the user's own headings — is global. AGENTS.md is
 * only ever parsed and filtered, never rewritten; MEMORY.md is the one doc
 * this module serializes, so its shape is ours.
 *
 * There is no filesystem in an extension, so these are storage-backed strings
 * edited on the options page — the filenames are the mental model, not a path.
 */
export const DOC_NAMES = ["AGENTS.md", "MEMORY.md"] as const;
export type DocName = (typeof DOC_NAMES)[number];

/**
 * On out of the box: an agent that re-learns the same page dance every run is
 * the weaker default. Off stops both halves — nothing is read, nothing is
 * written, and the `remember` tool is not offered to the model at all.
 */
export const memoryEnabled = defineItem<boolean>("memoryEnabled", true);

/**
 * What earns a line in MEMORY.md. One definition, quoted verbatim by all three
 * surfaces that write the file — the `remember` tool description, the in-run
 * MEMORY.md section, and the post-run extraction prompt.
 *
 * They were three separate wordings once, and they drifted: only the tool
 * description asked for a standalone sentence, and none of them named readings
 * as a rejected class (their examples of "one-off" were all actions, which a run
 * that just read a dashboard does not recognize itself in). The auto-save path
 * duly saved "148 users, 135 active in 7d" — no subject, and stale within the
 * hour. Shared text is what keeps a fix to the criteria from landing on one
 * surface and missing the other two.
 */
export const DURABLE_FACT_RULES = `A durable fact is still true months from now, and a future run would want it before it starts:
- A stable fact about the user, such as an account they use, an address or how they prefer something done.
- A site quirk you could only learn through use, such as the login that actually works, a step a form silently requires or a page whose structure misleads.

A fact about one site belongs to that site. Scope it to its registrable domain ("acme.com", so every subdomain loads it), naming a subdomain only when the fact holds nowhere else. Only facts about the user themselves, true on every site, are global.

Never save a reading. Counts, metrics, prices, balances, statuses, dates, search results, message text and anything else a page displayed today answer this task and belong in your summary, not in memory, because it will be wrong the next time anyone looks. Save what the page taught, not what it showed: not "the dashboard showed 1,018 visitors in 7 days", but "this dashboard opens on a 7-day window".

Write each fact to stand alone. It is read months later, beside unrelated facts, with nothing left of the task that produced it. Name what it is about: the site, the account, the thing. A fact that opens with a number and names no subject is unreadable later; do not save it.

Never save secrets: passwords, API keys, card numbers, security answers. Never save anything already in the memory you were shown.`;

const docItem = (name: DocName) => defineItem<string>(`doc:${name}`, "");

/**
 * ponytail: memory is flat bullet lists capped by characters per scope,
 * oldest-first — not scored, dated, or deduped by meaning, and the doc as a
 * whole is unbounded (each site adds up to a cap's worth). Ceilings: a stale
 * fact sits there until the user deletes it, and a heavy multi-site user grows
 * the stored doc without limit (the prompt stays bounded — one run loads
 * global + its site). Upgrade path: one record per memory with a timestamp,
 * a relevance pass, and least-recently-written site eviction.
 */
const MAX_SCOPE_CHARS = 4_000;

export function getDoc(name: DocName): Promise<string> {
  return docItem(name).get();
}

export function setDoc(name: DocName, content: string): Promise<void> {
  return docItem(name).set(content);
}

export function watchDoc(name: DocName, cb: (content: string) => void): () => void {
  return docItem(name).watch(cb);
}

const SITE_HEADING = /^##\s*site:\s*(.+?)\s*$/i;
const ANY_HEADING = /^#{1,6}(\s|$)/;

interface SiteSection {
  host: string;
  lines: string[];
}

interface ScopedDoc {
  global: string[];
  sections: SiteSection[];
}

/** A stored fact line — headings are structure, never facts. */
function isFactLine(line: string): boolean {
  return !ANY_HEADING.test(line);
}

/**
 * The normalized host a `## site:` heading names — null for any other line.
 * Null also covers a `site:` heading whose host cannot be normalized: both
 * walks below then treat it as an ordinary heading, so a junk host fails open
 * to global — visible on every run and fixable, never silently vanished.
 */
function siteHeadingHost(line: string): string | null {
  const heading = SITE_HEADING.exec(line);
  return heading?.[1] ? normalizeHost(heading[1]) : null;
}

/** The section for `host`, created on first use — the parser and `remember` share it. */
function sectionFor(sections: SiteSection[], host: string): SiteSection {
  let section = sections.find((s) => s.host === host);
  if (!section) {
    section = { host, lines: [] };
    sections.push(section);
  }
  return section;
}

/**
 * Split a doc into its global lines and `## site:` sections. Blank lines are
 * noise and dropped. Any heading that names no site closes an open section, so
 * a user's own `## headings` never get captured by a site above them.
 */
function parseScopes(doc: string): ScopedDoc {
  const global: string[] = [];
  const sections: SiteSection[] = [];
  let current = global;
  for (const raw of doc.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    const host = siteHeadingHost(line);
    if (host) {
      current = sectionFor(sections, host).lines;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      current = global;
      global.push(line);
      continue;
    }
    current.push(line);
  }
  return { global, sections };
}

/** MEMORY.md writes only — AGENTS.md is the user's prose and is never rewritten. */
function serializeScopes({ global, sections }: ScopedDoc): string {
  const out = [...global];
  for (const s of sections) {
    // An emptied section takes its heading with it.
    if (s.lines.length > 0) out.push(`## site: ${s.host}`, ...s.lines);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/**
 * The slice of a doc a run on `host` should see: global content plus matching
 * `## site:` sections, headings included so the reader knows what is scoped.
 * A null host (chrome://, no tab) keeps only the global content. Order and
 * spacing are preserved — this is a filter, not a rewrite.
 */
export function filterDocForHost(doc: string, host: string | null): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of doc.split("\n")) {
    const sectionHost = siteHeadingHost(line);
    if (sectionHost) {
      dropping = host === null || !hostMatches(sectionHost, host);
      if (!dropping) kept.push(line);
      continue;
    }
    // Any other heading — the user's own, or a junk `site:` one — ends the drop.
    if (ANY_HEADING.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

function stripMarker(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

function normalize(line: string): string {
  return stripMarker(line).toLowerCase();
}

/**
 * Appends one fact to MEMORY.md — into the site's section when `site` names
 * one, the global list otherwise (an unusable site falls back to global rather
 * than losing the fact). Returns the stored fact with the scope it actually
 * landed in — the one place that decision is made, so callers never re-derive
 * it — or null if the model sent something empty. Re-remembering a known fact
 * is a no-op rather than an error — models restate what they already know all
 * the time.
 */
export async function remember(fact: string, site?: string): Promise<ScopedFact | null> {
  // Collapse first, then trim, then drop a list marker the model added itself —
  // stripping before the trim misses "  - fact", which is what they actually send.
  const entry = fact
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();
  if (!entry) return null;

  const scope = site ? normalizeHost(site) : null;
  const item = docItem("MEMORY.md");
  const scoped = parseScopes(await item.get());
  const lines = scope ? sectionFor(scoped.sections, scope).lines : scoped.global;
  const saved: ScopedFact = { text: entry, ...(scope ? { site: scope } : {}) };

  // Dedupe within the scope only — the same lesson can legitimately hold both
  // globally and on one site, and cross-scope "which copy wins" isn't worth it.
  if (lines.some((line) => isFactLine(line) && normalize(line) === normalize(entry))) return saved;

  const stored = `- ${entry}`;
  lines.push(stored);
  // Evict this scope's oldest facts past its cap — never a heading, never the
  // entry just written, and never another scope's lines.
  const size = () => lines.filter(isFactLine).join("\n").length;
  while (size() > MAX_SCOPE_CHARS) {
    const oldest = lines.findIndex((line) => isFactLine(line) && line !== stored);
    if (oldest === -1) break;
    lines.splice(oldest, 1);
  }

  await item.set(serializeScopes(scoped));
  return saved;
}

/** One fact with its scope; `site` absent means global — loaded on every run. */
export interface ScopedFact {
  text: string;
  site?: string;
}

/** One displayable group of facts; `site` absent is the global group. */
export interface MemoryGroup {
  site?: string;
  facts: string[];
}

/** MEMORY.md as displayable fact groups — the global facts first, then each site's, in doc order. */
export function listMemory(doc: string): MemoryGroup[] {
  const { global, sections } = parseScopes(doc);
  const groups: MemoryGroup[] = [];
  const globalFacts = global.filter(isFactLine).map(stripMarker);
  if (globalFacts.length > 0) groups.push({ facts: globalFacts });
  for (const s of sections)
    if (s.lines.length > 0) groups.push({ site: s.host, facts: s.lines.map(stripMarker) });
  return groups;
}

/**
 * Delete one fact from MEMORY.md — matched by display text within its scope,
 * so the list and the store agree. A site section's last fact takes the
 * section heading with it.
 */
export async function removeMemory(entry: string, site?: string): Promise<void> {
  const scoped = parseScopes(await getDoc("MEMORY.md"));
  const keep = (line: string) => !isFactLine(line) || stripMarker(line) !== entry;
  if (site) {
    const section = scoped.sections.find((s) => s.host === site);
    if (section) section.lines = section.lines.filter(keep);
  } else {
    scoped.global = scoped.global.filter(keep);
  }
  await setDoc("MEMORY.md", serializeScopes(scoped));
}

/** Everything the agent's system prompt needs, resolved once at run start. */
export interface AgentContext {
  /** AGENTS.md, filtered to this run's site — always loaded; the toggle governs memory, not your instructions. */
  instructions: string;
  /** MEMORY.md, filtered to this run's site — empty string when memory is off. */
  memory: string;
  memoryOn: boolean;
}

/**
 * Load both docs for a run starting on `url`: global content plus the sections
 * for that site. No url — or one with no site, like chrome:// — loads global
 * content only.
 */
export async function loadAgentContext(url?: string): Promise<AgentContext> {
  const host = scopeHostOf(url);
  const [instructions, memoryOn] = await Promise.all([getDoc("AGENTS.md"), memoryEnabled.get()]);
  return {
    instructions: filterDocForHost(instructions, host).trim(),
    memory: memoryOn ? filterDocForHost(await getDoc("MEMORY.md"), host).trim() : "",
    memoryOn,
  };
}
