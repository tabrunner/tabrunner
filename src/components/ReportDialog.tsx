import { useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { issueDraft, issueUrl, type ReportProvider } from "@/lib/report";
import { Button, buttonClasses } from "./Button";
import { Switch } from "./Switch";
import { TextArea } from "./TextArea";
import { TextField } from "./TextField";
import { TitledDialog } from "./TitledDialog";

/**
 * The review step in front of every "report an issue" door. The GitHub link
 * carries its text in the address, so GitHub has it the moment the page opens —
 * this is the last place the person can read it, edit it, or leave the details
 * out. Mounted only while open: mounting IS the reset, so each report starts
 * from the provider and error of the moment, never from the last one's edits.
 */
function ReportForm({
  provider,
  error,
  onClose,
}: {
  provider?: ReportProvider;
  error?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft] = useState(() => issueDraft({ provider, error }));
  const [title, setTitle] = useState(draft.title);
  const [details, setDetails] = useState(draft.details);
  const [include, setInclude] = useState(true);

  return (
    <div className="flex flex-col gap-3">
      <TextField
        label={t("report.issueTitle")}
        placeholder={t("report.titlePlaceholder")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t("report.details")}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("report.detailsHint")}
            </p>
          </div>
          <Switch checked={include} onChange={setInclude} ariaLabel={t("report.include")} />
        </div>
        {/* Disabled rather than hidden: the layout holds still, and the reader
            still sees what they are leaving out. */}
        <TextArea
          aria-label={t("report.details")}
          rows={8}
          spellCheck={false}
          value={details}
          disabled={!include}
          onChange={(e) => setDetails(e.target.value)}
          className="w-full font-mono"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {/* A real anchor, wearing the button's classes: this is the one step
            that leaves the extension, and Base UI's Button would stamp
            `type="button"` onto an <a>. */}
        <a
          href={issueUrl({ title, details: include ? details : "" })}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className={buttonClasses("primary", "md")}
        >
          {t("report.open")}
        </a>
      </div>
    </div>
  );
}

/**
 * "Report an issue", reviewed before it leaves: the settings menu, the options
 * page, the help sheet and an unexpected error all open this. Pass `trigger`
 * to open it from an element, or `open`/`onOpenChange` to drive it from a menu
 * that closes itself first.
 */
export function ReportDialog({
  provider,
  error,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  provider?: ReportProvider;
  /** The raw error text; scrubbed before the reader ever sees it. */
  error?: string;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  return (
    <TitledDialog
      open={open}
      onOpenChange={setOpen}
      title={t("report.title")}
      description={t("report.description")}
      {...(trigger ? { trigger } : {})}
    >
      {open && <ReportForm provider={provider} error={error} onClose={() => setOpen(false)} />}
    </TitledDialog>
  );
}
