import { createLogger } from "@/lib/logger";

const log = createLogger("boot");

/**
 * The panel's cold open, in the order the milestones must land:
 * - `eval`   — the shell loaded, then every app chunk fetched, parsed and
 *              evaluated (measured from navigation start, so this one segment
 *              holds the whole module graph)
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
 * The chain cannot see what the browser does with the page, so the line ends
 * with three browser-side stamps: `doc` is when the HTML finished arriving,
 * `shown` is when the browser made the panel visible, `paint` is when the boot
 * cover became pixels. `shown` is the one that matters most: Chromium keeps an
 * extension side panel hidden until its first load finishes, and a hidden panel
 * runs at background priority. A large `shown` means something joined the
 * shell's load again (see shell.ts). A large `paint` after a small `shown` is a
 * renderer that could not draw. A large `doc` is a browser slow to hand the page
 * over.
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
 * The milestones the browser owns, as absolute times rather than segments: they
 * interleave with `eval` (a first paint can land either side of the module
 * graph), and a chain that pretended otherwise would print a negative segment
 * on exactly the slow opens it exists to explain.
 */
function browserSide(): string {
  const [entry] = performance.getEntriesByType("navigation");
  const nav = entry instanceof PerformanceNavigationTiming ? entry : undefined;
  const shown = performance.getEntriesByType("visibility-state").find((e) => e.name === "visible");
  const paint = performance.getEntriesByType("paint")[0];
  return [
    nav ? `doc ${Math.round(nav.responseEnd)}ms` : "doc unknown",
    shown ? `shown ${Math.round(shown.startTime)}ms` : "shown never",
    // Absent means the cover has not been drawn even once — the panel reached
    // its content without the browser ever producing a frame for it.
    paint ? `paint ${Math.round(paint.startTime)}ms` : "paint never",
  ].join(", ");
}
