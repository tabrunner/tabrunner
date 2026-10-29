import { createWriteQueue, defineItem } from "@/lib/storage";
import { tipsEnabled } from "@/lib/prefs";
import { TIPS, type TipId } from "./registry";

/** Persisted rotation state: the panel-open counter and when each tip last showed. */
export interface TipStats {
  opens: number;
  shown: Record<string, number>;
}

const tipStats = defineItem<TipStats>("tipStats", { opens: 0, shown: {} });

// The panel fires picks from an event stream — concurrent ones would read the
// same stats and double-record, so every read-modify-write shares one queue.
const serialized = createWriteQueue();

/** A panel open is our "session" — cooldowns count these, not wall-clock. */
export function notePanelOpen(): Promise<void> {
  return serialized(async () => {
    const stats = await tipStats.get();
    await tipStats.set({ ...stats, opens: stats.opens + 1 });
  });
}

/**
 * Claude Code's scheduler, reduced: a tip is eligible once it has cooled down
 * (never-shown always is), and among the eligible the one not shown for the
 * longest wins — a fair round-robin, not random, so the tail of the list gets
 * seen. `null` when everything is cooling down: a missing tip is fine, a
 * repetitive one is not.
 */
export function selectTip(stats: TipStats): TipId | null {
  let best: TipId | null = null;
  let bestAgo = -1;
  for (const tip of TIPS) {
    const last = stats.shown[tip.id];
    const ago = last === undefined ? Number.POSITIVE_INFINITY : stats.opens - last;
    if (ago < tip.cooldownOpens) continue;
    if (ago > bestAgo) {
      best = tip.id;
      bestAgo = ago;
    }
  }
  return best;
}

/** Pick the next tip and record the showing. I/O thin, logic in `selectTip`. */
export function pickTip(): Promise<TipId | null> {
  return serialized(async () => {
    if (!(await tipsEnabled.get())) return null;
    const stats = await tipStats.get();
    const id = selectTip(stats);
    if (id !== null) {
      await tipStats.set({ ...stats, shown: { ...stats.shown, [id]: stats.opens } });
    }
    return id;
  });
}
