import { Dialog } from "@base-ui-components/react";
import { XIcon } from "./Icon";
import { overlayMotion, scrimMotion } from "./chrome";
import { useTranslation } from "react-i18next";

/**
 * An image that opens a lightbox on click. The thumbnail keeps whatever styling
 * the call site gives it; the dialog is a scrim plus the image fitted to the
 * panel, dismissed by Escape, backdrop click, or the close button.
 */
export function ZoomableImage({
  src,
  alt,
  caption,
  className,
}: {
  src: string;
  alt: string;
  /** Line under the enlarged image; defaults to the alt text. */
  caption?: string;
  /** Classes for the thumbnail img itself. */
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root>
      <Dialog.Trigger
        title={t("chat.enlargeTitle")}
        render={
          <button
            type="button"
            className="block max-w-full cursor-zoom-in self-start overflow-hidden rounded focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          />
        }
      >
        <img src={src} alt={alt} className={`block max-w-full ${className ?? ""}`} />
      </Dialog.Trigger>
      <Dialog.Portal>
        {/* The house overlay motion, over the darker photo scrim `chrome.ts`
            sanctions for this one lightbox — it is the panel's most-opened
            overlay, so it was also the most conspicuous hard cut. */}
        <Dialog.Backdrop
          className={`fixed inset-0 z-50 bg-black/70 dark:bg-black/80 ${scrimMotion}`}
        />
        <Dialog.Popup
          className={`fixed top-1/2 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 ${overlayMotion}`}
        >
          <img
            src={src}
            alt={alt}
            className="block max-h-[80vh] max-w-full rounded object-contain shadow-2xl"
          />
          <Dialog.Title className="mt-2 text-center text-xs text-neutral-300">
            {caption ?? alt}
          </Dialog.Title>
          <Dialog.Close
            aria-label={t("common.close")}
            className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-sm text-white hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
          >
            <XIcon size={16} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
