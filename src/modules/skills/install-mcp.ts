import { listMcpServers, saveServer } from "@/modules/mcp/store";
import type { SkillMcpRef } from "./types";

/**
 * Installing an opted-in skill server is a ONE-WAY COPY into the MCP registry:
 * the skill suggests servers, but disable/delete on either side never touches
 * the other — provenance lives in Settings → MCP from then on. Nothing here
 * overwrites an existing record: a name collision (case-insensitive, the tool
 * token's rule) skips, so a skill import can never silently re-point a server
 * the user already runs.
 */
export type InstallOutcome = "installed" | "duplicate" | "failed";

export async function installSkillServers(refs: readonly SkillMcpRef[]): Promise<InstallOutcome[]> {
  const existing = new Set((await listMcpServers()).map((s) => s.name.toLowerCase()));
  const outcomes: InstallOutcome[] = [];
  for (const ref of refs) {
    const name = ref.name.trim();
    if (!name || existing.has(name.toLowerCase())) {
      outcomes.push("duplicate");
      continue;
    }
    const result = await saveServer({
      name,
      url: ref.url.trim(),
      ...(ref.headers ? { headers: ref.headers } : {}),
      enabled: true,
    });
    if (result.ok) existing.add(name.toLowerCase());
    outcomes.push(result.ok ? "installed" : "failed");
  }
  return outcomes;
}
