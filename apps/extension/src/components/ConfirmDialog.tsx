import { AlertDialog } from "@base-ui-components/react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { buttonClasses } from "./Button";
import { overlayCard, overlayMotion, scrim, scrimMotion } from "./chrome";

/**
 * Destructive-action confirmation. The trigger element must forward props
 * (our Button does). Never fire a destructive action without one of these.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: ReactElement;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={trigger as ReactElement<Record<string, unknown>>} />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={`${scrim} ${scrimMotion}`} />
        <AlertDialog.Popup
          className={`fixed top-1/2 left-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 p-4 ${overlayCard} ${overlayMotion}`}
        >
          <AlertDialog.Title className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {description}
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close className={buttonClasses("ghost", "md")}>
              {t("common.cancel")}
            </AlertDialog.Close>
            <AlertDialog.Close className={buttonClasses("danger", "md")} onClick={onConfirm}>
              {confirmLabel ?? t("common.remove")}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
