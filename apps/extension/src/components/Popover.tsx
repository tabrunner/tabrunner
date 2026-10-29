import { Popover as BasePopover } from "@base-ui-components/react";
import type { ReactElement, ReactNode } from "react";
import { overlayCard, overlayMotion } from "./chrome";

/**
 * Anchored, non-blocking overlay for glanceable content — where a dialog would
 * hijack the screen for a look-and-leave. The trigger element must forward
 * props (our Button does).
 *
 * Uncontrolled by default; pass `open`/`onOpenChange` when the content needs
 * to close itself (a commit click inside — popovers don't auto-close).
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  className = "",
}: {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra popup classes — the default card is w-64 p-3. */
  className?: string;
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger as ReactElement<Record<string, unknown>>} />
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={6} className="z-50">
          {/* Anchored, so it grows out of its trigger — the Positioner publishes
              the side it actually resolved to as `--transform-origin`. */}
          <BasePopover.Popup
            className={`w-64 origin-[var(--transform-origin)] p-3 ${overlayCard} ${overlayMotion} ${className}`}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
