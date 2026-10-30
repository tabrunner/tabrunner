import {
  MessageScroller as Scroller,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@shadcn/react/message-scroller";
import type { ComponentProps } from "react";

/** Styled shells over @shadcn/react's headless message scroller (shadcn's chat
 *  primitives, June 2026), house tokens: the Provider owns follow-the-live-edge
 *  and saved-transcript restoration; the viewport is the scroll region; items
 *  are the measured rows position-keeping works on. The library's turn
 *  anchoring (scrollAnchor) stays off: a landing message must never move the
 *  view of a reader who scrolled away. */
export function MessageScrollerProvider(props: ComponentProps<typeof Scroller.Provider>) {
  return <Scroller.Provider {...props} />;
}

export function MessageScroller({
  className = "",
  ...props
}: ComponentProps<typeof Scroller.Root>) {
  return (
    <Scroller.Root
      data-slot="message-scroller"
      className={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${className}`}
      {...props}
    />
  );
}

export function MessageScrollerViewport({
  className = "",
  ...props
}: ComponentProps<typeof Scroller.Viewport>) {
  return (
    <Scroller.Viewport
      data-slot="message-scroller-viewport"
      // The explicit background is not decoration: under a short transcript the
      // anchoring spacer leaves a tall transparent dead zone, and Chrome fills
      // unpainted canvas there with the dark-scheme root grey — a featureless
      // block swallowing the space under the last message. Painting the
      // viewport leaves nothing for the root canvas to show through.
      className={`min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white p-3 dark:bg-neutral-950 ${className}`}
      {...props}
    />
  );
}

export function MessageScrollerContent({
  className = "",
  ...props
}: ComponentProps<typeof Scroller.Content>) {
  return (
    <Scroller.Content
      data-slot="message-scroller-content"
      className={`flex h-max min-h-full flex-col gap-2 ${className}`}
      {...props}
    />
  );
}

export function MessageScrollerItem({
  className = "",
  ...props
}: ComponentProps<typeof Scroller.Item>) {
  return (
    <Scroller.Item
      data-slot="message-scroller-item"
      className={`flex min-w-0 shrink-0 flex-col ${className}`}
      {...props}
    />
  );
}

export { useMessageScroller, useMessageScrollerScrollable };
