import { Dialog } from "@base-ui-components/react";
import { useTranslation } from "react-i18next";
import { overlayCard, overlayMotion, scrim, scrimMotion } from "@/components/chrome";
import { XIcon } from "@/components/Icon";
import { LINKS } from "@/lib/links";
import { newIssueUrl } from "@/lib/report";
import { activeProviderOf, useProvidersStore } from "@/modules/providers/ui";
import { setHelpOpen, useHelpOpen } from "./help-open";
import { COMMANDS, commandDescription } from "./slash-commands";

/**
 * The reference sheet behind /help, the composer's "?" gesture, and the
 * settings menu's Help item — consultable WHILE a run works, which a
 * transcript note (gone on reopen, scrolled away) never is. The command table
 * is generated from COMMANDS so it cannot drift from what "/" completes; the
 * shortcut rows are the few chords no menu can surface.
 */
export function HelpDialog() {
  const { t } = useTranslation();
  const open = useHelpOpen();
  // The same provider every surface calls active — the report URL names it.
  const provider = useProvidersStore(activeProviderOf);

  const shortcuts: { chord: string; label: string }[] = [
    { chord: "Enter", label: t("help.keys.send") },
    { chord: "Shift+Enter", label: t("help.keys.newline") },
    { chord: "Esc", label: t("help.keys.stop") },
    { chord: "↑ ↓", label: t("help.keys.recall") },
    { chord: "E", label: t("help.keys.plan") },
    { chord: "?", label: t("help.keys.open") },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={setHelpOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`${scrim} ${scrimMotion}`} />
        <Dialog.Popup
          className={`fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-80 -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-4 ${overlayCard} ${overlayMotion}`}
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t("help.title")}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t("common.close")}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <XIcon />
            </Dialog.Close>
          </div>

          <div className="mt-3 text-[11px] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
            {t("help.shortcuts")}
          </div>
          <div className="mt-1">
            {shortcuts.map((s) => (
              <div key={s.chord} className="flex items-baseline gap-2.5 py-0.5">
                <kbd className="w-20 shrink-0 rounded border border-neutral-200 bg-neutral-50 px-1 py-px text-center font-mono text-[10px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  {s.chord}
                </kbd>
                <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-400">
                  {s.label}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 text-[11px] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
            {t("help.commands")}
          </div>
          <div className="mt-1">
            {COMMANDS.map((c) => (
              <div key={c.name} className="flex items-baseline gap-2.5 py-0.5">
                <span className="w-20 shrink-0 font-mono text-xs text-brand-600 dark:text-brand-400">
                  /{c.name}
                </span>
                <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-400">
                  {commandDescription(c)}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-col border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <a
              href={LINKS.site}
              target="_blank"
              rel="noreferrer"
              className="rounded px-1 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {t("help.docs")}
            </a>
            <a
              href={newIssueUrl({ provider })}
              target="_blank"
              rel="noreferrer"
              className="rounded px-1 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {t("settings.reportIssue")}
            </a>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
