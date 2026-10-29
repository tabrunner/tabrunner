import type { ComponentProps } from "react";

/**
 * Styled multiline input. Base UI has no textarea part (Field.Control renders
 * a single-line input), so the shared composer styling lives here instead.
 * `bare` strips the chrome (border, radius, focus ring) for a parent card that
 * owns them — the chat composer wraps its input in one.
 */
export function TextArea({
  bare = false,
  className = "",
  ...props
}: ComponentProps<"textarea"> & { bare?: boolean }) {
  const chrome = bare
    ? "bg-transparent focus:outline-none"
    : "rounded-lg border border-neutral-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-500 focus:outline-none dark:border-neutral-600";
  return (
    <textarea
      className={`resize-none px-3 py-2 text-sm placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-40 dark:placeholder:text-neutral-500 ${chrome} ${className}`}
      {...props}
    />
  );
}
