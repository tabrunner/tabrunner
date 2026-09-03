import { useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "@base-ui-components/react";
import { useTranslation } from "react-i18next";
import { AddProviderDialog, useProvidersStore, activeProviderOf } from "@/modules/providers/ui";
import { openHelp } from "@/modules/conversation/ui";
import { Button, buttonClasses } from "@/components/Button";
import { Switch } from "@/components/Switch";
import { overlayCard, overlayMotion } from "@/components/chrome";
import { useStoredItem } from "@/components/useStoredItem";
import { ThemeToggle } from "@/components/ThemeControl";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Icon } from "@/components/Icon";
import { widgetHidden } from "@/lib/prefs";
import { newIssueUrl } from "@/lib/report";

function GearIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.66.79 1.13 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-1 py-1.5">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Panel settings home — the preferences you change while working (theme,
 * language) inline, and one step out to the options page for the rest.
 */
export function SettingsMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  // Stored inverted ("hidden") so the default needs no write; shown here as
  // the positive toggle.
  const hidden = useStoredItem(widgetHidden);
  // The same provider every other surface calls active — a report is only
  // reproducible if it names the one the run actually used.
  const provider = useProvidersStore(activeProviderOf);

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={`shrink-0 px-1.5 ${open ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
              title={t("settings.menuTitle")}
              aria-label={t("settings.menuTitle")}
            >
              <GearIcon />
            </Button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner sideOffset={6} align="end" className="z-50">
            {/* Anchored, so it grows from the gear it hangs off rather than
                from its own centre — same recipe as the options page's menus. */}
            <Popover.Popup
              className={`w-64 origin-[var(--transform-origin)] p-2 ${overlayCard} ${overlayMotion}`}
            >
              <Section label={t("settings.appearance")}>
                <ThemeToggle className="w-full" />
              </Section>
              <Section label={t("settings.language")}>
                <LanguageToggle className="w-full" />
              </Section>
              <div className="flex items-center justify-between gap-3 px-1 py-1.5">
                <div className="min-w-0">
                  {/* A control's label, not a Section overline — wearing the
                      heading type made the menu read as a third section whose
                      only content was a switch floating beside its own title. */}
                  <div className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {t("settings.showWidget")}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                    {t("settings.showWidgetHint")}
                  </div>
                </div>
                <Switch
                  checked={!hidden}
                  onChange={(v) => void widgetHidden.set(!v)}
                  ariaLabel={t("settings.showWidget")}
                />
              </div>
              <div className="mt-1 flex flex-col border-t border-neutral-100 pt-1 dark:border-neutral-800">
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-left"
                  onClick={() => {
                    // The dialog lives outside the popover, so closing here is safe.
                    setOpen(false);
                    setAddProviderOpen(true);
                  }}
                >
                  {t("settings.addProvider")}
                </Button>
                {/* The lost user's door sits above the broken-build door:
                    "what can this do?" is the more common question, and the
                    sheet it opens carries the report link too. */}{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-left"
                  onClick={() => {
                    setOpen(false);
                    openHelp();
                  }}
                >
                  {t("help.title")}
                </Button>
                {/* The other half of the feedback path. The error bubble covers
                    "it broke"; the report worth the most — "it did the wrong
                    thing" — ends a run green, with no red bubble to click, so
                    it needs a door that is open at all times. */}
                <a
                  href={newIssueUrl({ provider })}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                  className={`block text-left ${buttonClasses("ghost", "sm")}`}
                >
                  {t("settings.reportIssue")}
                </a>
                {/* The escape hatch sits last, where "the rest lives here" is
                    read after every door this menu opens directly — the same
                    convention as the browser's own Settings row. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-left"
                  onClick={() => {
                    setOpen(false);
                    void chrome.runtime.openOptionsPage();
                  }}
                >
                  {t("settings.allSettings")}
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <AddProviderDialog open={addProviderOpen} onOpenChange={setAddProviderOpen} />
    </>
  );
}
