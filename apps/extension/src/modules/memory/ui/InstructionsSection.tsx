import { useTranslation } from "react-i18next";
import { TextArea } from "@/components/TextArea";
import { useStoredDoc } from "./useStoredDoc";

/**
 * The user's standing instructions — they apply to every chat, they are not
 * memory. Free prose in a plain-language box: the model reads it as rules, so
 * no markdown needed. Always on, autosaved.
 */
export function InstructionsSection() {
  const { t } = useTranslation();
  const { text, saved, ref, edit } = useStoredDoc("AGENTS.md");

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        {t("instructions.title")}
      </h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {t("instructions.help")}
      </p>

      <TextArea
        ref={ref}
        value={text}
        onChange={(e) => edit(e.target.value)}
        rows={6}
        aria-label={t("instructions.title")}
        placeholder={t("instructions.placeholder")}
        className="mt-3 w-full bg-white text-sm leading-relaxed text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
      />

      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {/* Its own element so each save replays the beat — the standing line is
            just text, and text swapped in place says nothing happened. */}
        {saved ? (
          // inline-block, or the rise half of `arrive` is dropped — inline boxes
          // aren't transformable.
          <span className="arrive inline-block">{t("memory.saved")}</span>
        ) : (
          t("instructions.autosave")
        )}
      </p>
    </section>
  );
}
