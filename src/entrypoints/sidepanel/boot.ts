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
 *
 * The chain starts at navigation start, which is the one thing it cannot see:
 * a panel that sat blank for half a minute and then logs a 400ms chain spent
 * that half minute BEFORE the document existed — the browser's own side of the
 * open, where nothing we render can reach. So the line ends with the two
 * browser-side stamps that tell those apart: `doc` is when the HTML finished
 * arriving, `paint` is when the boot cover became pixels. A slow open with a
 * small `doc` and a small `paint` was slow before we were born; a large `paint`
 * against a small `doc` is a renderer that had the document and could not draw
 * it; a large `doc` is a browser slow to hand it over.
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
  log.info(`panel open: ${segments.join(" · ")} — ${Math.round(prev)}ms total (${browserSide()})`);
}

/**
 * The two milestones the browser owns, as absolute times rather than segments:
 * they interleave with `eval` (a first paint can land either side of the module
 * graph), and a chain that pretended otherwise would print a negative segment
 * on exactly the slow opens it exists to explain.
 */
function browserSide(): string {
  const [entry] = performance.getEntriesByType("navigation");
  const nav = entry instanceof PerformanceNavigationTiming ? entry : undefined;
  const paint = performance.getEntriesByType("paint")[0];
  return [
    nav ? `doc ${Math.round(nav.responseEnd)}ms` : "doc unknown",
    // Absent means the cover has not been drawn even once — the panel reached
    // its content without the browser ever producing a frame for it.
    paint ? `paint ${Math.round(paint.startTime)}ms` : "paint never",
  ].join(", ");
}
