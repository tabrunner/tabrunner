import { Field } from "@base-ui-components/react";
import type { ReactNode } from "react";

/** Input chrome shared by every field control — size classes append to this.
 *  Focus speaks the one brand idiom: the flare ring (same as buttons), not a
 *  bare border recolor. */
export const inputChrome =
  "rounded-lg border border-neutral-300 placeholder:text-neutral-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 focus:outline-none dark:border-neutral-600 dark:placeholder:text-neutral-500";

/**
 * The label/control/description scaffolding Base UI Field wires up (htmlFor/id,
 * aria-describedby) — TextField and PasswordField render their controls inside
 * it instead of re-declaring it.
 */
export function FieldShell({
  label,
  hint,
  className = "",
  children,
}: {
  label?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field.Root className={`flex flex-col gap-1 text-sm ${className}`}>
      {label && (
        <Field.Label className="font-medium text-neutral-700 dark:text-neutral-300">
          {label}
        </Field.Label>
      )}
      {children}
      {hint && (
        <Field.Description className="text-xs text-neutral-500 dark:text-neutral-400">
          {hint}
        </Field.Description>
      )}
    </Field.Root>
  );
}
