import { useTranslation } from "react-i18next";
import { localeItem, LOCALE_LABELS, SUPPORTED_LOCALES } from "@/i18n";
import type { Locale } from "@/i18n";
import { SegmentedControl } from "./SegmentedControl";
import type { SegmentedOption } from "./SegmentedControl";
import { useStoredItem } from "./useStoredItem";

/**
 * Sentinel for auto (follow the browser). Must be a non-empty string: Base UI's
 * Toggle drops an empty-string value out of group control, leaving the segment
 * uncontrolled — the picker then opens with nothing active and lets auto AND a
 * locale look pressed at once.
 */
const AUTO = "auto";
type LocaleChoice = Locale | typeof AUTO;

/** Short codes keep four segments readable in a 400px side panel. */
const SHORT: Record<Locale, string> = { en: "EN", "pt-BR": "PT", es: "ES" };

export function LanguageToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  // Stored as null = auto; the control shows that as the AUTO segment.
  const stored = useStoredItem(localeItem);
  const locale: LocaleChoice = stored ?? AUTO;
  const options: SegmentedOption<LocaleChoice>[] = [
    { value: AUTO, label: t("settings.languageAutoShort"), title: t("settings.languageAuto") },
    ...SUPPORTED_LOCALES.map((l) => ({ value: l, label: SHORT[l], title: LOCALE_LABELS[l] })),
  ];
  return (
    <SegmentedControl
      value={locale}
      onChange={(choice) => void localeItem.set(choice === AUTO ? null : choice)}
      options={options}
      ariaLabel={t("settings.language")}
      className={className}
    />
  );
}
