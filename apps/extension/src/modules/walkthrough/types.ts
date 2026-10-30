/**
 * What a documented run leaves behind: one recording per run, one frame per
 * documented action. Shared by the recorder (worker), the doc builder (pure),
 * the panel card, and the viewer page — so it lives apart from all four.
 */

/**
 * How a recording ended. `recording` is the only live state; a manifest still
 * wearing it at boot outlived its worker and becomes `partial`.
 *
 * A walkthrough that silently skips steps is the failure mode this module
 * refuses — every state but `complete` is disclosed in the doc's own intro.
 */
export type RecordingStatus = "recording" | "complete" | "partial" | "truncated";

/** Why a frame has no image. Rendered as a placeholder step, never skipped. */
export type FrameGap = "timeout" | "restricted" | "unattached";

/** The run's ending, as the doc's outro reports it. */
export type RecordingOutcome = "done" | "stopped" | "error";

export interface Recording {
  id: string;
  conversationId: string;
  /** The task that was documented — the doc's title until the model writes one. */
  title: string;
  status: RecordingStatus;
  startedAt: number;
  endedAt?: number;
  /** Frames stored, gaps included. */
  frames: number;
  /** Total image bytes — what the caps and the Settings storage line count. */
  bytes: number;
  /** Hosts the run worked on, in first-seen order — the doc header's "Site" line. */
  sites: string[];
  /**
   * The step index the recorder armed at. Non-zero means the run had already
   * acted before it was told to document, and the doc says so up front.
   */
  armedAtStep: number;
  /**
   * The arm-time capture probe failed: this environment cannot screenshot the
   * driven tab (a pre-131 Chrome, a frozen tab, a page that refuses). Declared
   * once, up front, instead of stalling on every frame.
   */
  degraded?: boolean;
  outcome?: RecordingOutcome;
  /** The run's own closing summary — the doc's "what this accomplishes" outro. */
  summary?: string;
}

/**
 * One documented action: the screen it happened on, plus everything the caption
 * needs. Self-contained on purpose — the transcript keeps step rows only inside
 * its newest window (`RECENT_WINDOW`), so a 200-step run's doc cannot be
 * rebuilt by joining against it.
 */
export interface Frame {
  recordingId: string;
  /** 0-based, dense, assigned in capture order — the frames store's sort key. */
  seq: number;
  /** JPEG. Absent exactly when `gap` is set. */
  blob?: Blob;
  gap?: FrameGap;
  /** The tool this frame documents. `""` on the opening and closing frames. */
  tool: string;
  args: Record<string, unknown>;
  url: string;
  title: string;
  ts: number;
  /**
   * Whether the action this frame documents actually succeeded — patched on
   * with the click once the tool resolves. A failed attempt is dropped at
   * assembly, which is what collapses a retried click into one step.
   */
  ok?: boolean;
  /**
   * Where the agent clicked, in CSS viewport pixels — patched on after the
   * click resolves, since the frame is captured before it happens. Drawn as
   * the emerald marker, positioned against `viewport`.
   */
  click?: { x: number; y: number };
  /** CSS viewport size at capture, so `click` can be placed as a fraction. */
  viewport?: { width: number; height: number };
}

/** A recording plus its frames — what the viewer and the doc builder read. */
export interface LoadedRecording {
  recording: Recording;
  frames: Frame[];
}

/** One rendered step of the finished document. */
export interface DocStep {
  /** 1-based, as printed. Gaps and the opening frame get their own numbering rules. */
  number: number;
  /** The imperative line: "Click **Compose**". */
  caption: string;
  /** The value a reader must copy, already masked when it looked like a secret. */
  value?: string;
  frame: Frame;
}
