import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react";
import { XIcon } from "./Icon";
import { overlayCard, overlayMotion, scrim, scrimMotion } from "./chrome";

/**
 * The titled modal frame — backdrop, centered auto-height popup, header with
 * title, optional description and the ✕ — shared by every form-in-a-dialog
 * (provider, skill editor/import/draft). Callers keep only their body and
 * their open-state semantics (`key` remounts, `open &&` guards).
 */
export function TitledDialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  widthClass = "w-[min(26rem,calc(100vw-2rem))]",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Optional element that opens the dialog itself (Dialog.Trigger). */
  trigger?: ReactElement;
  /** A full Tailwind width utility — literal at the call site so the JIT sees it. */
  widthClass?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger render={trigger as ReactElement<Record<string, unknown>>} />}
      <Dialog.Portal>
        <Dialog.Backdrop className={`${scrim} ${scrimMotion}`} />
        <Dialog.Popup
          className={`fixed top-1/2 left-1/2 z-50 max-h-[90vh] ${widthClass} -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-4 ${overlayCard} ${overlayMotion}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label={t("common.close")}
              className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              <XIcon />
            </Dialog.Close>
          </div>
          <div className="mt-3">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
