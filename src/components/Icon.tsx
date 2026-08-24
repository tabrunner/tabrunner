import type { ReactNode } from "react";

/**
 * The shared svg shell for the panel's stroke icons — each icon is just its
 * paths. Stroke inherits currentColor, so icons follow the text color.
 */
export function Icon({
  size = 14,
  className,
  children,
}: {
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/*
 * Icons used in exactly one place stay in that file. These are the ones the
 * panel repeats across components, and every place that lacked a local copy had
 * reached for a typeface glyph instead ("✓ ✗ • ▸ ▾ ✕") — so their weight, size
 * and baseline came from whatever font resolved, next to drawn icons that
 * didn't. One stroke family straightens the whole column.
 */
type IconProps = { size?: number; className?: string };

/** Disclosure. Points right when closed; call sites rotate it 90° when open. */
export function ChevronRightIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="m9.5 5.5 6 6.5-6 6.5" />
    </Icon>
  );
}

/** A select trigger — the one chevron that points down at rest. */
export function ChevronDownIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="m5.5 9.5 6.5 6 6.5-6" />
    </Icon>
  );
}

export function CheckIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="m5.25 12.75 4.5 4.5 9-10.5" />
    </Icon>
  );
}

/** Copy — two overlapping rounds; the back one opens to the upper-left. */
export function CopyIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <rect width="13" height="13" x="9" y="9" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

export function XIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

/** A step not started, a tool call with nothing to report, a provider offline. */
export function DotIcon({ size, className, filled }: IconProps & { filled?: boolean }) {
  return (
    <Icon size={size} className={className}>
      <circle cx="12" cy="12" r={filled ? 4 : 5} fill={filled ? "currentColor" : "none"} />
    </Icon>
  );
}

/** Edit a stored row — conversations, skills. */
export function PencilIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Icon>
  );
}

/** Delete a stored row — always behind a confirm. */
export function TrashIcon({ size, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
    </Icon>
  );
}
