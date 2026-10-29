import { hostMatches } from "@/lib/host";
import type { Skill } from "./types";

/**
 * Mid-run activation: the site-scoped skills that just became relevant because
 * the driven tab landed on their host. Unsited skills and start-site matches
 * never appear here — they were listed in the run-start catalog already. The
 * caller tracks announced names, so each skill surfaces exactly once per run
 * no matter how its site list overlaps another's.
 */
export function newlyApplicableSkills(
  all: readonly Skill[],
  host: string | null,
  announced: ReadonlySet<string>,
): Skill[] {
  if (host === null) return [];
  return all.filter((s) => {
    if (announced.has(s.name)) return false;
    const sites = s.sites;
    if (!sites?.length) return false;
    return sites.some((site) => hostMatches(site, host));
  });
}
