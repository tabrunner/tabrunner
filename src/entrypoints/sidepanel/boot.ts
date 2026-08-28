import { createLogger } from "@/lib/logger";

const log = createLogger("boot");

/**
 * The panel's cold open, in the order the milestones must land:
 * - `eval`   — every chunk fetched, parsed and evaluated (measured from
 *              navigation start, so this one segment holds the module graph)
 * - `i18n`   — catalogs initialised; React may mount
 * - `mount`  — App's first commit
 * - `providers` — the provider list is in, so the shell can tell onboarding
 *              from chat
 * - `content`  — the open conversation's transcript is rendered; the boot
 *              cover comes off here
 *
 * Which segment owns a slow open is otherwise unanswerable without a profiler,
 * and the answer differs cold (first open of the day: storage is disk) from
 * warm (everything cached). One line per open, at info — a panel opens rarely
 * enough that it reads as lifecycle, not chatter.
 */
const STAGES = ["eval", "i18n", "mount", "providers", "content"] as const;
type Stage = (typeof STAGES)[number];

const at = new Map<Stage, number>();

/** Timestamp one milestone. The last one prints the whole chain. */
export function mark(stage: Stage): void {
  // Effects re-run; a boot happens once. First timestamp wins.
  if (at.has(stage)) return;
  at.set(stage, performance.now());
  if (stage !== "content") return;

  const segments: string[] = [];
  let prev = 0;
  for (const s of STAGES) {
    const t = at.get(s);
    if (t === undefined) continue;
    segments.push(`${s} +${Math.round(t - prev)}ms`);
    prev = t;
  }
  log.info(`panel open: ${segments.join(" · ")} — ${Math.round(prev)}ms total`);
}
