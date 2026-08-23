import { useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TitledDialog } from "@/components/TitledDialog";
import { ProviderForm } from "./ProviderForm";
import { providerName } from "../presets";
import type { ProviderConfig } from "../types";

/**
 * The add-provider form in a dialog — shared by the options page, the side-panel
 * onboarding, chat error recovery, and the header provider select. Auto-height;
 * scrolls only past 90vh. Pass `initialProvider` to open it as an edit
 * ("Update …"); pass `open`/`onOpenChange` to drive it without a trigger element.
 */
export function AddProviderDialog({
  trigger,
  initialProvider,
  open: openProp,
  onOpenChange,
  onSaved,
}: {
  trigger?: ReactElement;
  initialProvider?: ProviderConfig;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** After a successful save or sign-in, once the dialog has closed — e.g. retry
   *  the run a fresh credential unblocks, or point this chat at the new provider. */
  onSaved?: (id: string) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const { t } = useTranslation();
  return (
    <TitledDialog
      open={open}
      onOpenChange={setOpen}
      title={
        initialProvider
          ? t("providerForm.update", { name: providerName(initialProvider) })
          : t("addProvider.title")
      }
      description={t("addProvider.description")}
      {...(trigger ? { trigger } : {})}
    >
      <ProviderForm
        onSaved={(id) => {
          setOpen(false);
          onSaved?.(id);
        }}
        initialProvider={initialProvider}
      />
    </TitledDialog>
  );
}
