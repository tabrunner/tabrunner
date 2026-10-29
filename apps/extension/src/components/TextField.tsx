import { Field } from "@base-ui-components/react";
import type { ComponentProps, ReactNode } from "react";
import { FieldShell, inputChrome } from "./FieldShell";

/** Matches Select's scale: sm = panel-header density, md = forms. */
const SIZES = {
  md: "px-3 py-2",
  sm: "px-2 py-1 text-xs",
} as const;

/**
 * Labeled text input — Base UI Field wires label ↔ control (htmlFor/id) and
 * description ↔ control (aria-describedby). Use for every text input.
 * `className` is appended for layout; pick density with `size`, not by
 * re-declaring padding (Tailwind wouldn't resolve the conflict predictably).
 */
export function TextField({
  label,
  hint,
  size = "md",
  className = "",
  ...props
}: /* the DOM `size` attribute (a character count) is not something we use;
     className is layout-only — Base UI's state-callback form doesn't survive
     the shell's string interpolation */
Omit<ComponentProps<typeof Field.Control>, "size" | "className"> & {
  label?: string;
  hint?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <FieldShell label={label} hint={hint} className={className}>
      <Field.Control className={`${inputChrome} ${SIZES[size]}`} {...props} />
    </FieldShell>
  );
}
