import { useTranslation } from "react-i18next";
import { CheckIcon, ChevronRightIcon, DotIcon } from "@/components/Icon";

/**
 * Tag for a step the run will stop on and ask about (it pays, sends or
 * deletes). Neutral on purpose: emerald is for action and gold for measuring,
 * and a warning is neither. An outline sets it apart from the filled "new"
 * chip the re-ask card uses.
 */
export function AsksFirstTag() {
  const { t } = useTranslation();
  return (
    <span className="ml-1.5 rounded-sm border border-neutral-300 px-1 align-[1px] text-[10px] font-medium tracking-wide text-neutral-600 uppercase dark:border-neutral-600 dark:text-neutral-300">
      {t("plan.stepAsks")}
    </span>
  );
}

/**
 * One visual language for plan steps — the transcript card and the footer peek
 * both render it, and they must never disagree about a step's mark or its
 * color. Two functions (a glyph and a class) could drift; one component cannot,
 * which is why they collapsed into this.
 *
 * The geometry is the run console's on tabrunner.app — same check, same chevron
 * for the step in flight — so the plan reads the same in the hero and in the
 * panel. Emerald for what the run finished, gold for what it is working on
 * right now (gold measures, per the `telemetry` rule), faint for what's ahead.
 */
export function PlanMark({ index, current }: { index: number; current: number }) {
  // mt-px optically centers a 14px mark on the first line of 12px text, and
  // keeps it there when a long step wraps — which centering the row would not.
  const base = "mt-px shrink-0";
  if (index < current)
    return <CheckIcon className={`${base} text-brand-700 dark:text-brand-400`} />;
  if (index === current)
    return <ChevronRightIcon className={`${base} text-amber-700 dark:text-amber-300`} />;
  return <DotIcon filled className={`${base} text-neutral-400 dark:text-neutral-500`} />;
}
