import { Button as BaseButton } from "@base-ui-components/react";
import type { ComponentProps } from "react";

type Variant =
  "primary" | "danger" | "ghost" | "ghost-danger" | "outline" | "choice" | "nav" | "quiet-brand";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-500 text-brand-950 hover:bg-brand-600 active:bg-brand-700",
  danger: "bg-red-600 text-white hover:bg-red-700 active:bg-red-800",
  ghost:
    "text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:active:bg-neutral-700",
  "ghost-danger":
    "text-red-600 hover:bg-red-50 active:bg-red-100 dark:text-red-400 dark:hover:bg-red-950 dark:active:bg-red-900",
  outline:
    "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:active:bg-neutral-700",
  // A reply you are about to send: brand-tinted chip, right-aligned toward the
  // composer, filling toward the user bubble's own emerald as you commit to it.
  choice:
    "border border-brand-300 bg-brand-50 text-brand-800 hover:border-brand-500 hover:bg-brand-100 active:bg-brand-200 dark:border-brand-800 dark:bg-brand-950/60 dark:text-brand-200 dark:hover:border-brand-600 dark:hover:bg-brand-900 dark:active:bg-brand-800",
  // A settings-nav destination: quiet until it's the page you're on — the
  // active page carries the brand tint via aria-current.
  nav: "text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-800 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:active:bg-neutral-700 dark:aria-[current=page]:bg-brand-950/60 dark:aria-[current=page]:text-brand-200",
  // An action sitting inside a report — a status line, the live run band. It
  // must read as pressable where a ghost's neutral text would read as more
  // label. A variant rather than a className override: both are plain text
  // utilities, so the winner is CSS order, not the order they were passed.
  "quiet-brand":
    "text-brand-700 hover:bg-brand-100 active:bg-brand-200 dark:text-brand-300 dark:hover:bg-brand-900 dark:active:bg-brand-800",
};

const SIZES: Record<Size, string> = {
  sm: "rounded-lg px-2 py-1 text-xs",
  md: "rounded-lg px-3 py-2 text-sm",
  // The one circular button: the composer's send/stop glyph (agentic-IDE idiom).
  icon: "rounded-full p-1.5",
};

/** Class helper for places that render a button through another Base UI part
 *  (e.g. AlertDialog.Close) and can't use the Button component itself. */
export function buttonClasses(variant: Variant = "primary", size: Size = "md"): string {
  // The ring offset separates the brand ring from filled variants — and it must
  // name the ground: Tailwind's default offset color is white, which reads as a
  // pale halo around every focused button on the dark ground.
  return `font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-950 ${VARIANTS[variant]} ${SIZES[size]}`;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<typeof BaseButton> & { variant?: Variant; size?: Size }) {
  return <BaseButton className={`${buttonClasses(variant, size)} ${className}`} {...props} />;
}
