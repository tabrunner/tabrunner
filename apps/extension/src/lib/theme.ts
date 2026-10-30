import { defineItem } from "./storage";

export type ThemeMode = "system" | "light" | "dark";

/** Light/dark preference — "system" (default) follows the OS. */
export const themeMode = defineItem<ThemeMode>("themeMode", "system");

export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/**
 * Toggles the `dark` class on <html> (Tailwind's class strategy) and keeps it
 * in sync: with the OS while mode is "system", and with storage when the other
 * context (panel ↔ options) changes it. Call once per entrypoint, before render
 * — the first apply is synchronous, so there's no flash of the wrong theme.
 */
export function initTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  let mode: ThemeMode = "system";
  const apply = () => {
    document.documentElement.classList.toggle("dark", resolveDark(mode, mq.matches));
  };
  mq.addEventListener("change", apply);
  const unwatch = themeMode.watch((v) => {
    mode = v;
    apply();
  });
  void themeMode.get().then((v) => {
    mode = v;
    apply();
  });
  apply();
  return () => {
    mq.removeEventListener("change", apply);
    unwatch();
  };
}
