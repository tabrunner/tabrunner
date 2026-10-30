import { Toggle, ToggleGroup } from "@base-ui-components/react";
import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tooltip + accessible name — required when the label is an icon or an abbreviation. */
  title?: string;
}

/**
 * One-of-N picker for short, stable option sets (theme, language) where seeing
 * every choice at once beats hiding them behind a Select.
 * Values must be non-empty: Base UI's Toggle drops "" out of group control,
 * leaving that segment uncontrolled.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        // Pressing the active segment would clear the group — a one-of-N picker
        // has no empty state, so only a real option counts.
        const picked = options.find((o) => o.value === next[0]);
        if (picked) onChange(picked.value);
      }}
      aria-label={ariaLabel}
      className={`inline-flex gap-0.5 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800 ${className}`}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          title={o.title}
          aria-label={o.title}
          /* Pressed wears the selection idiom (the nav's brand tint), not a
             white-on-gray chip that vanishes in light mode. */
          className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-600 transition-colors hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 data-[pressed]:bg-brand-50 data-[pressed]:text-brand-800 data-[pressed]:shadow-sm dark:text-neutral-400 dark:hover:text-neutral-100 dark:data-[pressed]:bg-brand-950/60 dark:data-[pressed]:text-brand-200"
        >
          {o.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
