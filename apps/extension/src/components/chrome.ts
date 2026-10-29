/**
 * The one overlay recipe — dialogs (ConfirmDialog, AddProviderDialog), the
 * anchored Popover, and the settings menu all float the same card over the
 * same scrim. Call sites add only what their role changes (width, padding,
 * centering vs anchoring). ZoomableImage's lightbox is the sanctioned
 * exception: a photo scrim goes darker on purpose.
 */
export const scrim = "fixed inset-0 z-50 bg-black/30 dark:bg-black/60";

export const overlayCard =
  "rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900";

/**
 * The overlay's arrival, driven by Base UI's `data-starting-style` /
 * `data-ending-style` — the popup grows in from just under size and leaves the
 * same way, so a modal reads as landing on the page rather than being cut to.
 *
 * **`scale`, not `transform`.** Tailwind v4 compiles `scale-*` to the standalone
 * `scale` property (and `-translate-*` to `translate`), which
 * `transition-property: transform` does not cover — listing `transform` here
 * would silently animate nothing. An anchored popup adds
 * `origin-[var(--transform-origin)]` so it grows from its trigger; a centered
 * dialog wants the default center origin and adds nothing.
 *
 * `motion-reduce:transition-none` is the house rule, not a nicety: every other
 * animation in the panel carries a reduced-motion fallback, and these are the
 * only motion that arrived as a transition rather than a keyframe — so they
 * need the variant instead of a `@media` block. Dropping the transition simply
 * lands the popup at its final state; nothing it says is carried by the move.
 */
export const overlayMotion =
  "transition-[opacity,scale] duration-150 motion-reduce:transition-none data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0";

/** The scrim only fades, and a touch slower — it is the room dimming, not an object. */
export const scrimMotion =
  "transition-opacity duration-200 motion-reduce:transition-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";
