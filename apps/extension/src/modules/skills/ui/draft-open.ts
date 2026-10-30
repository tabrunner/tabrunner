import { useSyncExternalStore } from "react";
import { createOpenFlag } from "@/lib/open-flag";

/**
 * The draft dialog's open state, shared module-level so `/skill new`
 * (slash-commands.ts is not a component) can open the one SkillDraftDialog the
 * side panel renders — the help sheet's exact pattern.
 */
const flag = createOpenFlag();

export const setSkillDraftOpen = flag.set;

export function openSkillDraft(): void {
  flag.set(true);
}

export function useSkillDraftOpen(): boolean {
  return useSyncExternalStore(flag.subscribe, flag.get);
}
