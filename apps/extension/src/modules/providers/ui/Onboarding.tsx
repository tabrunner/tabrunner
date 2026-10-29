import { useTranslation } from "react-i18next";
import { AddProviderDialog } from "./AddProviderDialog";
import { PRESETS } from "../presets";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/Button";

/**
 * First-run home — shown in the side panel while no provider is configured.
 *
 * The one screen that is nothing but first impression, so it assembles rather
 * than appearing: the mark lands, then each line follows it in. The delays are
 * one budget (~500ms end to end) and live here beside the markup they belong
 * to. Deliberately the product's own tile and not a comet pose — this is the
 * moment the user learns which icon in the toolbar is TabRunner.
 */
export function Onboarding() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
      <span className="rise-in">
        <BrandMark size={56} glow />
      </span>
      <div
        className="rise-in mt-5 text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-100"
        style={{ animationDelay: "90ms" }}
      >
        {t("onboarding.title")}
      </div>
      <p
        className="rise-in mt-2 max-w-[300px] text-sm leading-relaxed text-neutral-600 dark:text-neutral-300"
        style={{ animationDelay: "160ms" }}
      >
        {t("onboarding.tagline")}
      </p>
      <p
        className="rise-in mt-3 max-w-[300px] text-xs leading-relaxed text-neutral-500 dark:text-neutral-400"
        style={{ animationDelay: "230ms" }}
      >
        {t("onboarding.connectPrompt")}
      </p>
      <AddProviderDialog
        trigger={
          <Button className="rise-in mt-5" style={{ animationDelay: "300ms" }}>
            {t("onboarding.addProvider")}
          </Button>
        }
      />
      <p
        className="rise-in mt-2.5 max-w-[300px] text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400"
        style={{ animationDelay: "370ms" }}
      >
        {t("onboarding.presetsNote", { count: PRESETS.length })}
      </p>
    </div>
  );
}
