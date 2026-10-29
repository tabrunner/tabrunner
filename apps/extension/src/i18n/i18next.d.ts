import type en from "./locales/en.json";

/** English catalog is the typed source of truth — t() keys autocomplete and typecheck. */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
