import { Switch as BaseSwitch } from "@base-ui-components/react";

/**
 * On/off for a single preference. A SegmentedControl would work but reads as a
 * choice between two things; a switch reads as "this feature is running", which
 * is what an enable toggle actually means.
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Hover text — for a switch that rides alone in a row with no visible label. */
  title?: string;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      // The ring needs its offset: checked, the track is brand and so is the
      // ring — in dark mode they are the same token, so without a ring of
      // ground between them a keyboard user loses the control entirely.
      className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-neutral-300 transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 data-[checked]:bg-brand-600 dark:bg-neutral-700 dark:data-[checked]:bg-brand-500 dark:focus-visible:ring-offset-neutral-950"
    >
      <BaseSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[checked]:translate-x-[1.125rem]" />
    </BaseSwitch.Root>
  );
}
