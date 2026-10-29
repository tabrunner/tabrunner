import { Select as BaseSelect } from "@base-ui-components/react";
import { Fragment, useId } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, ChevronDownIcon } from "./Icon";
import { overlayMotion } from "./chrome";

export interface SelectOption {
  value: string;
  label: string;
  /** Short qualifier pinned beside the label — never shrinks, so it survives
   *  truncation of a long label (e.g. a model id tagged "Auto"). */
  hint?: string;
  /** Render the hint before the label instead of after. Use when the qualifier
   *  is what distinguishes the row: two options can share a label (the auto
   *  choice and that same model pinned by hand), and a trailing chip is read
   *  too late to tell them apart. */
  hintLeading?: boolean;
  icon?: ReactNode;
  /** Rule above this item — separates trailing actions from the real choices. */
  separatorBefore?: boolean;
  /**
   * Section this option belongs to, rendered as a heading above the run of
   * options sharing it. Use when the sections answer a question the rows
   * can't — two ways to pay for the same list of providers — and order the
   * options so each section is contiguous; a group is a run, not a sort key.
   */
  group?: string;
}

/** Consecutive options sharing a `group` form one section. Ungrouped runs render bare. */
function sections(options: SelectOption[]): { group?: string; items: SelectOption[] }[] {
  const runs: { group?: string; items: SelectOption[] }[] = [];
  for (const option of options) {
    const last = runs.at(-1);
    if (last && last.group === option.group) last.items.push(option);
    else runs.push({ group: option.group, items: [option] });
  }
  return runs;
}

function Hint({ text }: { text: string }) {
  return (
    <span className="shrink-0 rounded border border-neutral-300 px-1 py-px text-[10px] font-medium text-neutral-500 dark:border-neutral-600 dark:text-neutral-400">
      {text}
    </span>
  );
}

type Size = "sm" | "md";
/** boxed = form control; quiet = header chip that reads as metadata, not a field. */
type Variant = "boxed" | "quiet";

/** sm = panel-header density, md = forms. */
const SIZES: Record<Size, { trigger: string; item: string; group: string }> = {
  md: {
    trigger: "px-3 py-2 text-sm",
    item: "px-3 py-1.5 text-sm",
    group: "px-3 pt-2.5 pb-1 text-[11px]",
  },
  sm: {
    trigger: "px-2 py-1 text-xs",
    item: "px-2 py-1 text-xs",
    group: "px-2 pt-2 pb-0.5 text-[10px]",
  },
};

const TRIGGER_VARIANTS: Record<Variant, string> = {
  boxed:
    "border border-neutral-300 bg-white text-neutral-900 hover:border-neutral-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 focus:outline-none data-[popup-open]:border-brand-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:border-neutral-500",
  quiet:
    "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none data-[popup-open]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-[popup-open]:bg-neutral-800",
};

/**
 * Styled Select over Base UI headless — supports a leading icon per option,
 * rendered in both the trigger and the popup items. The popup grows past the
 * trigger width (up to max-w-72) so long values like model ids stay readable.
 */
export function Select({
  value,
  onChange,
  options,
  className = "",
  size = "md",
  variant = "boxed",
  title,
  ariaLabel,
  label,
  iconOnlyTrigger = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  size?: Size;
  variant?: Variant;
  title?: string;
  ariaLabel?: string;
  /** Visible form label, wired to the trigger with aria-labelledby — the same
   *  voice as Field labels, so a Select sits in a form without faking it with
   *  an unassociated span. */
  label?: string;
  /** Compact trigger: the picked option's icon + chevron only, the full label
   *  lives in the popup rows and the tooltip. For dense strips where every
   *  option carries a distinctive icon (provider logos, mode glyphs). */
  iconOnlyTrigger?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const byValue = new Map(options.map((o) => [o.value, o]));
  const s = SIZES[size];

  const renderItem = (o: SelectOption) => {
    const hint = o.hint ? <Hint text={o.hint} /> : null;
    return (
      <Fragment key={o.value}>
        {/* Base UI's Select has no Separator part — a presentational
            rule keeps it out of the listbox's accessibility tree. */}
        {o.separatorBefore && (
          <div aria-hidden className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
        )}
        <BaseSelect.Item
          value={o.value}
          className={`flex cursor-default items-center gap-1.5 text-neutral-900 data-[highlighted]:bg-brand-50 data-[highlighted]:text-brand-900 dark:text-neutral-100 dark:data-[highlighted]:bg-brand-950 dark:data-[highlighted]:text-brand-100 ${s.item}`}
        >
          {o.icon}
          {o.hintLeading && hint}
          <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{o.label}</BaseSelect.ItemText>
          {!o.hintLeading && hint}
          <BaseSelect.ItemIndicator className="flex shrink-0 text-brand-600 dark:text-brand-400">
            <CheckIcon />
          </BaseSelect.ItemIndicator>
        </BaseSelect.Item>
      </Fragment>
    );
  };

  const trigger = (
    <BaseSelect.Trigger
      title={title}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      className={`flex items-center justify-between gap-2 rounded-lg ${TRIGGER_VARIANTS[variant]} ${s.trigger} ${className}`}
    >
      {/* min-w-0 lets the label truncate instead of shoving the chevron out. */}
      <BaseSelect.Value className="min-w-0">
        {(v: string) => {
          const opt = byValue.get(v);
          if (!opt)
            return (
              <span className="text-neutral-500 dark:text-neutral-400">
                {t("common.selectPlaceholder")}
              </span>
            );
          const hint = opt.hint ? <Hint text={opt.hint} /> : null;
          if (iconOnlyTrigger && opt.icon) return opt.icon;
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              {opt.icon}
              {opt.hintLeading && hint}
              <span className="truncate">{opt.label}</span>
              {!opt.hintLeading && hint}
            </span>
          );
        }}
      </BaseSelect.Value>
      <BaseSelect.Icon className="flex shrink-0 text-neutral-500 dark:text-neutral-400">
        <ChevronDownIcon />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );

  return (
    <BaseSelect.Root value={value} onValueChange={(v) => v !== null && onChange(v)}>
      {label ? (
        <div className="flex flex-col gap-1 text-sm">
          <span id={labelId} className="font-medium text-neutral-700 dark:text-neutral-300">
            {label}
          </span>
          {trigger}
        </div>
      ) : (
        trigger
      )}
      <BaseSelect.Portal>
        {/* alignItemWithTrigger would center the SELECTED item on the trigger, pushing
            earlier options above the viewport in a short side panel — they got clipped
            and looked missing. A plain dropdown always shows the list from the top. */}
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          {/* Grows out of the trigger, not out of its own middle — the
              Positioner publishes the resolved side as `--transform-origin`. */}
          <BaseSelect.Popup
            className={`max-h-72 w-max min-w-[var(--anchor-width)] max-w-72 origin-[var(--transform-origin)] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 ${overlayMotion}`}
          >
            {sections(options).map((section, i) =>
              section.group ? (
                <BaseSelect.Group key={section.group}>
                  {/* A muted heading alone reads as a disabled row at a glance;
                      the rule is what says "new section". The first one needs
                      none — the popup's own edge already is that seam. */}
                  {i > 0 && (
                    <div aria-hidden className="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
                  )}
                  <BaseSelect.GroupLabel
                    className={`font-medium text-neutral-500 dark:text-neutral-400 ${s.group}`}
                  >
                    {section.group}
                  </BaseSelect.GroupLabel>
                  {section.items.map(renderItem)}
                </BaseSelect.Group>
              ) : (
                // Keyed on its first option: an ungrouped run's identity is its
                // contents, and every value in the list is already unique.
                <Fragment key={section.items[0]!.value}>{section.items.map(renderItem)}</Fragment>
              ),
            )}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
