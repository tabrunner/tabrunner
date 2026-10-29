import { useEffect, useState } from "react";
import type { StorageItem } from "@/lib/storage";

/**
 * A stored preference as React state — seeded from the item's fallback, kept
 * live across contexts by the storage watch. Writes stay at the call site
 * (`void item.set(v)`); the watch carries the new value back here too.
 *
 * Lives in components/ because lib/ may not import React (runtime boundary).
 */
export function useStoredItem<T>(item: StorageItem<T>): T {
  const [value, setValue] = useState<T>(item.fallback);
  useEffect(() => {
    void item.get().then(setValue);
    return item.watch(setValue);
  }, [item]);
  return value;
}
