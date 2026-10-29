import { useTranslation } from "react-i18next";
import type { ThemeMode } from "@/lib/theme";
import { themeMode } from "@/lib/theme";
import { SegmentedControl } from "./SegmentedControl";
import type { SegmentedOption } from "./SegmentedControl";
import { useStoredItem } from "./useStoredItem";
import { Icon } from "./Icon";

function SunIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Icon>
  );
}

function MoonIcon() {
  return (
    <Icon>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </Icon>
  );
}

function MonitorIcon() {
  return (
    <Icon>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </Icon>
  );
}

/** Theme picker — all three modes visible, so "System" never hides behind a toggle. */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useStoredItem(themeMode);
  const options: SegmentedOption<ThemeMode>[] = [
    { value: "system", label: <MonitorIcon />, title: t("settings.themeSystem") },
    { value: "light", label: <SunIcon />, title: t("settings.themeLight") },
    { value: "dark", label: <MoonIcon />, title: t("settings.themeDark") },
  ];
  return (
    <SegmentedControl
      value={mode}
      onChange={(m) => void themeMode.set(m)}
      options={options}
      ariaLabel={t("settings.appearance")}
      className={className}
    />
  );
}
