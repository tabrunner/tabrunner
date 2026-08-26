import { useSyncExternalStore } from "react";
import { createOpenFlag } from "@/lib/open-flag";

/**
 * The manage dialog's open state, shared module-level so `/skills`
 * (slash-commands.ts is not a component) can open the one SkillsManageDialog
 * the side panel renders — the draft dialog's exact pattern.
 */
const flag = createOpenFlag();

export const setSkillsManageOpen = flag.set;

export function openSkillsManage(): void {
  flag.set(true);
}

export function useSkillsManageOpen(): boolean {
  return useSyncExternalStore(flag.subscribe, flag.get);
}
