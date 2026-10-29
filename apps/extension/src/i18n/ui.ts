import { initReactI18next } from "react-i18next";
import { i18n, initI18n } from "@/i18n";

/**
 * UI entrypoint bootstrap: attach the React bindings to the shared instance,
 * init, and keep <html lang> (+ optionally the tab title) in sync.
 * The title is a getter so the t() key stays typechecked at the call site.
 */
export async function initUiI18n(getTitle?: () => string): Promise<void> {
  i18n.use(initReactI18next);
  await initI18n();

  const sync = () => {
    document.documentElement.lang = i18n.language;
    if (getTitle) document.title = getTitle();
  };
  sync();
  i18n.on("languageChanged", sync);
}
