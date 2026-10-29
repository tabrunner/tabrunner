import { COMET_GEOMETRY } from "@/shared/logo";

/**
 * The comet-tab in postures. The brand mark is a tab in motion, so the mark
 * *is* the character — no face and no second animal to keep on-model.
 *
 * Two postures, and the count is the point. A first cut drew four — `ready`,
 * `resting`, `waiting`, `blocked` — one per feeling, and the sum was a mascot:
 * four of the seven Settings pages opened on a different lean of the logo, each
 * fading in on nav click, so clicking down the rail animated the mark through
 * moods. No single call site could see it. `waiting` also borrowed
 * `thinking-dot`, the panel's "the model is working right now" signal, and put
 * it in an idle empty room; `blocked` put a braking, dimmed comet on a
 * *preference the user had just chosen*, which is the product editorializing a
 * privacy call. Both are gone, and with them the gold trail, the lean, and the
 * pivot they leaned about.
 *
 * What survives is two rooms, not two moods:
 *   `ready`   — a room asking for a goal. The empty chat, and only there.
 *   `resting` — a room where nothing has happened yet. Everywhere else.
 *
 * Geometry comes from `shared/logo.ts` so the poses and the extension icon stay
 * one object. Color does not: the icon lives on its own deep-field tile, while
 * these sit on the panel's ground and must survive both themes, so the fills
 * are utilities.
 */
export type Pose = "ready" | "resting";

const { tab, dot, trail } = COMET_GEOMETRY;

/**
 * Quiet, but not a watermark. The first cut used `neutral-300 / dark:600`,
 * which measures 1.72:1 on white and 2.25:1 on the dark ground — under the 3:1
 * floor for non-text in *both* themes, so the only illustration in an empty
 * room rendered as a skeleton loader. One step in on each side clears it
 * (2.93:1 / 3.81:1) and still reads as background rather than as content.
 */
const QUIET = "fill-neutral-400 dark:fill-neutral-500";
const QUIET_STROKE = "stroke-neutral-400 dark:stroke-neutral-500";

/** The favicon dot is the eye — one step brighter than the vessel it rides. */
const DOT_AT_REST = "fill-neutral-500 dark:fill-neutral-400";
const DOT_READY = "fill-brand-500 dark:fill-brand-400";

/** `ready` is a landscape composition; `resting` is its own tighter one. */
const READY_ASPECT = 2.8;

/**
 * `resting` windows onto the mark's coordinates rather than inheriting the
 * icon's 48×48 square, because the drawing only ever occupies a band across the
 * middle of it — trail bar at x=11 through the body's right edge at 41, y 17
 * through 30. Rendered on the full square it came out a ~13px sliver floating in
 * a third of its own box.
 */
const POSE_VIEWBOX = "9 16 33 15";
const POSE_ASPECT = 33 / 15;

/**
 * Held above 2.5x the bar's own height — shorter than that and a "trail" is
 * just a dot beside the tab. The first cut used 3 and read as punctuation; the
 * second used 8, which is a hair under the rule it stated (3.25 x 2.5 = 8.125).
 * The test asserts the ratio rather than the number.
 */
const TRAIL_WIDTH = 9;

/** The vessel — one fill, and the same one the trail uses. It is not the light. */
function Body() {
  return <path d={tab} className={QUIET} />;
}

/**
 * `ready` is the one pose with somewhere to be: the body parked at the start of
 * a dashed trajectory that runs off to a target it hasn't reached. It is the
 * tagline drawn — you give the goal, it runs the tabs — so it earns the wider
 * canvas and belongs to the empty chat, which is the one room literally asking
 * for a goal.
 *
 * The route stays neutral and the favicon dot carries the only brand light.
 * That is the two-light rule read honestly: emerald means *acting*, and a comet
 * that has not been given a goal yet is not acting. An emerald runway would
 * promise motion the product cannot make until you type.
 */
function ReadyPose({ size, className }: { size: number; className?: string }) {
  return (
    // The canvas hugs the drawing — 112×40 with the body at 2× filling two
    // thirds of the height. A first pass laid the same parts out on the icon's
    // roomy 48-tall square and the body came out a ~19px smudge at the far left
    // of a mostly-empty box: an illustration you had to look for.
    <svg
      viewBox="0 0 112 40"
      height={size}
      width={size * READY_ASPECT}
      fill="none"
      className={className}
      aria-hidden
    >
      {/* Scale about the body's own centre, then place — so the dot rides along
          and stays on the tab instead of being positioned twice. Folded from the
          three-step chain that expressed it: 2p − (44, 27) is the same map. */}
      <g transform="translate(-44 -27) scale(2)">
        <Body />
        <circle cx={dot.cx} cy={dot.cy} r={dot.r} className={DOT_READY} />
      </g>
      <path
        d="M 42 20 C 62 20 68 13 86 12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="2 6"
        className={`comet-runway ${QUIET_STROKE}`}
      />
      <circle cx="98" cy="13" r="6" strokeWidth="1.75" className={QUIET_STROKE} />
      <circle cx="98" cy="13" r="2" className={QUIET} />
    </svg>
  );
}

/**
 * Parked, with one spent trail behind it. Deliberately the same drawing in
 * every room that has it — History, Skills, Memory, Schedules — because the
 * thing those rooms have in common is that nothing has happened in them yet,
 * and that is one meaning, not four. Giving each its own posture is what turned
 * the rail into a slideshow.
 */
function RestingPose({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox={POSE_VIEWBOX}
      height={size}
      width={size * POSE_ASPECT}
      fill="none"
      className={className}
      aria-hidden
    >
      <rect
        x={trail.endX - TRAIL_WIDTH}
        y={trail.nearY}
        width={TRAIL_WIDTH}
        height={trail.height}
        rx={trail.rx}
        className={QUIET}
      />
      <Body />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} className={DOT_AT_REST} />
    </svg>
  );
}

/**
 * Sized by HEIGHT; each pose sets its own width from it — `ready` is the wide
 * one at 2.8×, `resting` about 2.1×. Below ~32px tall the trail merges into the
 * body (the threshold that gave the icon set its "small" variant), so keep
 * these at illustration size and reach for `BrandMark` when you need a glyph.
 *
 * Both are `aria-hidden`: every call site pairs the drawing with a title and a
 * body that carry the meaning, so a `role="img"` label would announce the same
 * sentence twice.
 */
export function CometPose({
  pose,
  size = 48,
  className,
}: {
  pose: Pose;
  size?: number;
  className?: string;
}) {
  if (pose === "ready") return <ReadyPose size={size} className={className} />;
  return <RestingPose size={size} className={className} />;
}
