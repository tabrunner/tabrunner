import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { pickTip } from "../scheduler";
import type { TipId } from "../registry";

/**
 * The one current tip, shared module-level so the run band and the composer
 * footer show the SAME tip — two independent picks would also double-record
 * the showing. Re-picked only at boundaries (panel open, run end) by the
 * entrypoint calling `refreshTip`; never on a timer — Claude Code rotates per
 * turn, and our run is the turn.
 */
let current: TipId | null = null;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

export function refreshTip(): void {
  inflight ??= pickTip()
    .then((id) => {
      if (id !== current) {
        current = id;
        for (const l of listeners) l();
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current tip's translated text, or null when none should show. */
export function useTip(): string | null {
  const { t } = useTranslation();
  const id = useSyncExternalStore(subscribe, () => current);
  if (id === null) return null;
  // Object-map variant of the `run.idle` array pattern — the catalog owns the
  // copy, indexed here by the registry's id, so a reordered catalog can't
  // mislabel a tip.
  const tips = t("tips", { returnObjects: true });
  return tips[id] ?? null;
}
