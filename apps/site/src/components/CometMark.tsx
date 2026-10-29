/**
 * The TabRunner brand mark — the comet-tab: a browser-tab silhouette in
 * motion, burn trail behind it. Chosen 2026-08 (mark candidate A) to replace
 * the old circle-and-bars comet, which read as a crown at small sizes —
 * neither a tab nor a runner. The extension's icons regenerate from this
 * geometry at its redesign (chrome/src/shared/logo.ts, `bun run icons`).
 */
export function CometMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="TabRunner comet-tab mark"
    >
      <path
        d="M 23 30 L 23 20.5 Q 23 17 26.5 17 L 37.5 17 Q 41 17 41 20.5 L 41 30 Z"
        fill="#e8eefb"
      />
      <circle cx="27" cy="21.5" r="1.8" fill="#10b981" />
      <rect x="7" y="19.5" width="12" height="3.25" rx="1.625" fill="#34d399" />
      <rect x="10" y="26.25" width="9" height="3.25" rx="1.625" fill="#6ee7b7" />
    </svg>
  );
}
