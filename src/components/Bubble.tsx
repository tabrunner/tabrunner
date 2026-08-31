import type { ComponentProps } from "react";

type Variant = "user" | "pending" | "secondary" | "muted" | "destructive";

const VARIANTS: Record<Variant, string> = {
  /** The user's own turn — named for its role, because the variant that is
   *  actually the default here is `secondary`, the assistant's. The fill is
   *  re-decided per mode instead of shared: in light, saturated brand with dark
   *  ink is the only pair that separates from both the white ground and the
   *  pale assistant card. On the dark ground that same fill is L*67 — six times
   *  lighter than the assistant's card — so a thread of them reads as a ladder
   *  of highlighter slabs sitting above the answers the user came for. brand-900
   *  stays unmistakably the user's, and lets the ink run light like every other
   *  string in the panel (5.97:1 → 9.2:1).
   *
   *  Also the one variant that carries `whitespace-pre-wrap`: its child is the
   *  raw text the user typed, so its newlines are the message. Every other
   *  variant's child is parsed markdown (or its own `<pre>`), where the newlines
   *  BETWEEN block elements are just source formatting — under `pre-wrap` each
   *  one draws an empty line box, so a bullet list grew blank rows and model
   *  prose broke at the model's column instead of the panel's. */
  user: "bg-brand-500 text-brand-950 whitespace-pre-wrap dark:bg-brand-900 dark:text-brand-50",
  /** The user's turn, committed but not sent — a queued steer, a submission
   *  behind another run, a command waiting its turn. Same geometry and same
   *  side of the column as `user`, drawn as an outline over a whisper of the
   *  same brand: filled means sent, and at a glance that is the only thing the
   *  reader needs to tell apart. The dashed edge is the second, redundant
   *  signal — it survives both themes and a screenshot. Carries `user`'s
   *  `whitespace-pre-wrap` for the same reason: the child is raw typed text. */
  pending:
    "border border-dashed border-brand-400/70 bg-brand-50/60 text-neutral-700 whitespace-pre-wrap dark:border-brand-700 dark:bg-brand-950/40 dark:text-neutral-300",
  secondary: "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
  muted: "bg-neutral-100 dark:bg-neutral-800",
  /** An error is a notice, not an alarm: a whisper of red for shape, neutral
   *  text for the message, and the red accents left to the icon and actions. */
  destructive:
    "border border-red-200/70 bg-red-50/50 text-neutral-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-neutral-200",
};

/** Framed conversational content, adapted from shadcn/ui's Bubble
 *  (ui.shadcn.com/docs/components/base/bubble, base-nova): the frame carries
 *  variant + alignment, the content carries text flow. Trimmed to the variants
 *  and subcomponents TabRunner uses — no reactions, no polymorphic render. */
export function Bubble({
  variant = "secondary",
  align = "start",
  className = "",
  ...props
}: ComponentProps<"div"> & { variant?: Variant; align?: "start" | "end" }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={`flex w-fit max-w-[85%] min-w-0 flex-col rounded-lg px-3 py-2 text-sm break-words data-[align=end]:self-end ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function BubbleContent({ className = "", ...props }: ComponentProps<"div">) {
  return <div data-slot="bubble-content" className={`min-w-0 ${className}`} {...props} />;
}
