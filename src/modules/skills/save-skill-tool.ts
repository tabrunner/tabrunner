import { i18n } from "@/i18n";
import { fetchSkillMarkdown, resolveSkillSource } from "./import-url";
import { parseSkillMd } from "./skill-md";
import { saveSkill } from "./store";
import { normalizeSkillName } from "./types";
import { truncateTo } from "@/lib/format";

/**
 * The agent-side door to the library — `save_skill`'s engine. One pipeline with
 * every other inbound path (import-url → skill-md → saveSkill), so the caps,
 * the reserved names and the name-collision rule all apply unchanged; the
 * CONSENT is the difference: this runs on model say-so, so it leans on the
 * ask-first policy in the prompt and never overwrites — a name already taken
 * is an error the model reports, the same skip-and-say-so the bulk importer
 * uses. Errors come back as strings the tool returns verbatim.
 */
export type SaveSkillOutcome =
  { ok: true; saved: { name: string; description: string } } | { ok: false; error: string };

export async function handleSaveSkill(args: {
  url?: unknown;
  name?: unknown;
  sites?: unknown;
}): Promise<SaveSkillOutcome> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, error: i18n.t("errors.saveSkillNoUrl") };
  const source = resolveSkillSource(url);
  if (!source.ok) {
    return { ok: false, error: i18n.t("errors.saveSkillBadUrl", { url }) };
  }
  let text: string;
  try {
    text = await fetchSkillMarkdown(source.url);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const parsed = parseSkillMd(text);
  const name = normalizeSkillName(typeof args.name === "string" ? args.name : "") ?? parsed.name;
  if (!name) {
    return { ok: false, error: i18n.t("errors.saveSkillUnnamed") };
  }
  const overrides =
    Array.isArray(args.sites) && args.sites.length > 0
      ? args.sites.filter((s): s is string => typeof s === "string")
      : [];
  const result = await saveSkill({
    id: crypto.randomUUID(),
    name,
    description: parsed.description ?? name,
    ...(overrides.length > 0 ? { sites: overrides } : {}),
    body: parsed.body,
    enabled: true,
    source: { url: source.url },
  });
  if (!result.ok) return result;
  // The truncated line doubles as the tool result's confirmation — bounded,
  // so a giant description can't flood the wire payload.
  const shown = parsed.description ? `${name} — ${parsed.description}` : name;
  return { ok: true, saved: { name, description: truncateTo(shown, 300) } };
}
