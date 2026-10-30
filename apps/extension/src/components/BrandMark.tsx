/**
 * The comet-tab tile at UI sizes. The tile's deep-field ground vanishes on the
 * panel's own dark ground, so the mark always wears a hairline; the optional
 * aura is the one static glow — the first-run launch moment earns it.
 */
export function BrandMark({ size = 24, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {glow && (
        <span
          aria-hidden
          className="absolute -inset-2.5 rounded-full bg-brand-500/15 blur-md dark:bg-brand-400/15"
        />
      )}
      <img
        src="/icon.svg"
        alt=""
        width={size}
        height={size}
        className="relative rounded-[23%] ring-1 ring-black/5 dark:ring-white/10"
      />
    </span>
  );
}
