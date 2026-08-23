import type { ConversationEngine } from "@/modules/providers/types";

/** Sunday..Saturday, matching `Date#getDay` so no mapping table is needed. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * When a schedule fires. Three kinds cover everything asked of it — "at 3pm",
 * "every weekday at 9am", "every hour from 9 to 5" — and each one is readable
 * back to the user in a settings row, which a cron string is not.
 *
 * Times are wall-clock local strings ("09:00"), never offsets: the next fire is
 * recomputed from the calendar after every run, so a schedule set for 9am is
 * still 9am on the other side of a DST change. A cron parser could later emit
 * this shape, but it is never the stored model.
 */
export type Recurrence =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string; days?: Weekday[] }
  | {
      kind: "interval";
      everyMinutes: number;
      /** Active-hours window. `from` without `to` runs to midnight; a window
       *  that would cross midnight is rejected at validation. */
      from?: string;
      to?: string;
      days?: Weekday[];
    };

export interface Schedule {
  id: string;
  task: string;
  /**
   * Where the run's own tab opens. A scheduled run NEVER adopts the tab the
   * user is looking at — nobody is there to see the plan gate, and taking over
   * a page at 3am is the one thing this feature must not do.
   */
  url?: string;
  recurrence: Recurrence;
  /** One thread per schedule, so a recurring run can read what it did last time. */
  conversationId: string;
  /** Epoch ms of the next fire, recomputed after each run. */
  nextFireAt: number;
  createdAt: number;
  /**
   * What this schedule runs on, snapshotted when it was set up. A schedule's
   * whole promise is "runs the way I set it up", and its thread is not created
   * until the first fire — hours or days later, by which time the stored
   * default may name something else entirely. Absent on schedules made before
   * this field: they inherit at their next fire, as they always did.
   */
  engine?: ConversationEngine;
  /** Consecutive self-reschedules — the bound on an agent looping on itself. */
  chainCount?: number;
  lastRun?: { at: number; ok: boolean };
  /**
   * Held, not cancelled — the rule and the thread survive, only the alarm goes.
   * `nextFireAt` keeps its stale value while paused (nothing reads it), and
   * resuming recomputes it from now: arming a time that sat still while the
   * schedule was off would fire the instant the user flipped the switch.
   */
  paused?: boolean;
}
