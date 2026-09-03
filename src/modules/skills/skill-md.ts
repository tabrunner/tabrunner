import { normalizeHostList } from "@/lib/host";
import type { Skill, SkillMcpRef } from "./types";
import { MAX_MCP_PER_SKILL, normalizeSkillName } from "./types";

/**
 * SKILL.md is the interchange form — import (URL or paste), export, and the
 * distillation reply all pass through this one parser. Storage stays the
 * structured record; markdown exists only at the edges.
 *
 * The grammar is a deliberate subset of YAML frontmatter, hand-rolled (no YAML
 * dependency exists in this repo and one file format doesn't earn one):
 * `key: value` split on the FIRST colon so prose colons survive, `- item`
 * block lists, `[a, b]` inline lists — lists only for site keys, so a
 * description that happens to start with "[" stays prose. Tolerance is the
 * contract: a Claude Code SKILL.md with `allowed-tools`, `model`, or any
 * future key must import cleanly — unknown keys are reported, never fatal,
 * and a file with no frontmatter at all is just a body.
 */
export interface ParsedSkillMd {
  /** Normalized, valid name — absent when the file named nothing usable. */
  name?: string;
  description?: string;
  /** Normalized hosts, deduped. */
  sites: string[];
  body: string;
  /** Frontmatter keys present but not honored — a quiet preview note, never an error. */
  ignoredKeys: string[];
  /** Site entries that didn't normalize to a host — a preview warning. */
  droppedSites: string[];
  /**
   * `mcp_servers:` block entries that survived parsing, capped at
   * MAX_MCP_PER_SKILL. Install is a separate consent decision; parsing only
   * reports what the file carries.
   */
  mcpServers: SkillMcpRef[];
  /** Server rows without a name or an https URL (beyond the cap) — data for the preview note. */
  droppedMcpServers: string[];
}

const KEY_LINE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const LIST_ITEM = /^\s*-\s+(.*)$/;

function unquote(value: string): string {
  const t = value.trim();
  const q = t[0];
  return (q === '"' || q === "'") && t.length >= 2 && t.endsWith(q) ? t.slice(1, -1) : t;
}

/**
 * A `- name: acme` mini-map item from the `mcp_servers:` block — fields kept
 * as ordered pairs because `header:` may repeat (several credentials per
 * server) and pairs need no merge logic.
 */
interface RawMcpItem {
  fields: [string, string][];
}

type FrontValue = string | string[] | RawMcpItem[];

/** Frontmatter as raw key → scalar, scalar list, or mini-map list, with everything unrecognized skipped. */
function parseFrontmatter(lines: string[]): Map<string, FrontValue> {
  const entries = new Map<string, FrontValue>();
  for (let i = 0; i < lines.length; i++) {
    const match = KEY_LINE.exec(lines[i] ?? "");
    if (!match?.[1]) continue;
    const key = match[1].toLowerCase().replaceAll("-", "_");
    const value = (match[2] ?? "").trim();
    if (value) {
      entries.set(key, unquote(value));
      continue;
    }
    // A bare `key:` opens a block list. The `- key: value` shape starts a
    // MINI-MAP list instead: each item keeps consuming the indented lines
    // under it until the next dash or an outdent. One nesting level only.
    const first = LIST_ITEM.exec(lines[i + 1] ?? "");
    if (first?.[1] && KEY_LINE.test(first[1].trim())) {
      const maps: RawMcpItem[] = [];
      let current: RawMcpItem | undefined;
      while (i + 1 < lines.length) {
        const line = lines[i + 1] ?? "";
        const dash = LIST_ITEM.exec(line);
        const kv = dash ? KEY_LINE.exec(dash[1]?.trim() ?? "") : null;
        if (dash && kv?.[1]) {
          current = { fields: [[kv[1].toLowerCase().replaceAll("-", "_"), unquote(kv[2] ?? "")]] };
          maps.push(current);
          i++;
          continue;
        }
        if (!dash && /^\s+\S/.test(line)) {
          const cont = KEY_LINE.exec(line.trim());
          if (!cont?.[1] || !current) break;
          current.fields.push([cont[1].toLowerCase().replaceAll("-", "_"), unquote(cont[2] ?? "")]);
          i++;
          continue;
        }
        break;
      }
      entries.set(key, maps);
      continue;
    }
    // A bare `key:` opening a flat list — consume its `- item` lines.
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const item = LIST_ITEM.exec(lines[i + 1] ?? "");
      if (!item?.[1]) break;
      items.push(unquote(item[1]));
      i++;
    }
    entries.set(key, items);
  }
  return entries;
}

/** `[a, b]` / block list / bare scalar → list of raw entries. Mini-map lists never feed this. */
function asList(value: FrontValue): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  const inline = /^\[(.*)\]$/.exec(value.trim());
  const parts = inline?.[1] !== undefined ? inline[1].split(",") : [value];
  return parts.map((p) => unquote(p)).filter(Boolean);
}

function asScalar(value: FrontValue): string {
  if (Array.isArray(value))
    return value
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .trim();
  return typeof value === "string" ? value : "";
}

export function parseSkillMd(text: string): ParsedSkillMd {
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !(lines[start] ?? "").trim()) start++;

  let front = new Map<string, FrontValue>();
  let body = text.trim();
  if ((lines[start] ?? "").trim() === "---") {
    const close = lines.findIndex((l, i) => i > start && l.trim() === "---");
    // No closing fence: not frontmatter, just a document that opens with a rule.
    if (close !== -1) {
      front = parseFrontmatter(lines.slice(start + 1, close));
      body = lines
        .slice(close + 1)
        .join("\n")
        .trim();
    }
  }

  const rawSites = ["site", "sites"].flatMap((key) => {
    const value = front.get(key);
    return value === undefined ? [] : asList(value);
  });
  const { hosts: sites, dropped: droppedSites } = normalizeHostList(rawSites);

  const description =
    asScalar(front.get("description") ?? "") ||
    // when_to_use serves the same catalog line — a fallback, never an override.
    asScalar(front.get("when_to_use") ?? "");

  // The directory name is the identity in Claude Code; a lone file has only its
  // frontmatter — and failing that, its H1 is the closest thing to a title.
  const rawName = asScalar(front.get("name") ?? "");
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  const name = normalizeSkillName(rawName) ?? normalizeSkillName(h1) ?? undefined;

  const known = new Set(["name", "description", "site", "sites", "when_to_use", "mcp_servers"]);
  const ignoredKeys = [...front.keys()].filter((k) => !known.has(k));

  // mcp_servers → refs. A row without a name or URL is dropped and named in
  // the preview warning; header pairs split on the FIRST "=" (values carry
  // them) and collapse into the header map.
  const mcpServers: SkillMcpRef[] = [];
  const droppedMcpServers: string[] = [];
  const raw = front.get("mcp_servers");
  if (Array.isArray(raw)) {
    for (const item of raw) {
      // A flat scalar list under mcp_servers isn't our shape — ignored rows
      // would be noise, so skip them silently here.
      if (typeof item === "string" || !("fields" in item)) continue;
      let itemName = "";
      let url = "";
      const headers: Record<string, string> = {};
      for (const [field, value] of item.fields) {
        if (field === "name" && !itemName) itemName = value;
        else if (field === "url" && !url) url = value.trim();
        else if (field === "header") {
          const eq = value.indexOf("=");
          if (eq > 0) headers[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
        }
      }
      const label = itemName || "unnamed server";
      if (!itemName || !/^https?:\/\//i.test(url)) {
        droppedMcpServers.push(label);
        continue;
      }
      mcpServers.push({
        name: itemName,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  }
  while (mcpServers.length > MAX_MCP_PER_SKILL) {
    droppedMcpServers.push(mcpServers.pop()?.name ?? "");
  }

  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    sites,
    body,
    ignoredKeys,
    droppedSites,
    mcpServers,
    droppedMcpServers,
  };
}

/** The export form — round-trips through `parseSkillMd` (tested). */
export function serializeSkillMd(skill: Skill): string {
  const description = skill.description.replace(/\s*\n\s*/g, " ").trim();
  const front = [
    `name: ${skill.name}`,
    `description: ${description}`,
    ...(skill.sites?.length ? [`sites: [${skill.sites.join(", ")}]`] : []),
  ];
  if (skill.mcpServers?.length) {
    front.push(
      "mcp_servers:",
      ...skill.mcpServers.flatMap((s) => [
        `  - name: ${s.name}`,
        `    url: ${s.url}`,
        ...Object.entries(s.headers ?? {}).map(([k, v]) => `    header: ${k}=${v}`),
      ]),
    );
  }
  return `---\n${front.join("\n")}\n---\n\n${skill.body.trim()}\n`;
}
