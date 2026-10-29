import { useEffect, useState } from "react";
import { listSchedules, watchSchedules } from "../store";
import type { Schedule } from "../types";

/**
 * The stored schedules, kept live across the writes the worker makes as they
 * fire. Two surfaces read them and neither owns them: the settings list, and
 * the panel's delete confirm — which has to know a thread belongs to a schedule
 * before it offers to remove it.
 */
export function useSchedules(): Schedule[] {
  const [rows, setRows] = useState<Schedule[]>([]);
  useEffect(() => {
    let live = true;
    void listSchedules().then((v) => live && setRows(v));
    const unwatch = watchSchedules(setRows);
    return () => {
      live = false;
      unwatch();
    };
  }, []);
  return rows;
}
