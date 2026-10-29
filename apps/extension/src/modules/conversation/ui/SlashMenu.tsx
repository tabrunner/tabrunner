import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon } from "@/components/Icon";
import type { SlashItem } from "./slash-commands";

/**
 * The composer's slash-command autocomplete — a quiet list opening upward over
 * the transcript. All the keys live in ChatInput (arrows, Enter, Tab, Esc);
 * this is the dumb list. `role="listbox"` doubles as the panel-wide signal
 * that an overlay owns Esc, so dismissing it can never stop a run by surprise.
 */
export function SlashMenu({
  items,
  index,
  onHover,
  onPick,
}: {
  items: SlashItem[];
  index: number;
  onHover: (index: number) => void;
  onPick: (item: SlashItem, thisChatOnly: boolean) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // A long candidate list (many providers) scrolls — keep the highlight in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      ref={listRef}
      id="slash-menu"
      role="listbox"
      aria-label={t("commands.menuAria")}
      className="settle absolute inset-x-0 bottom-full z-50 mb-1.5 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          data-index={i}
          id={`slash-menu-item-${item.key}`}
          type="button"
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            // MouseDown, not click, and swallowed: picking must not blur the composer.
            e.preventDefault();
            onPick(item, e.altKey);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs ${
            i === index
              ? "bg-brand-50 text-brand-900 dark:bg-brand-950 dark:text-brand-100"
              : "text-neutral-700 dark:text-neutral-300"
          }`}
        >
          <span className="shrink-0 font-mono text-brand-600 dark:text-brand-400">
            {item.primary}
          </span>
          {item.secondary && (
            <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
              {item.secondary}
            </span>
          )}
          {item.current && (
            <span
              className="ml-auto flex shrink-0 text-brand-600 dark:text-brand-400"
              title={t("commands.current")}
            >
              <CheckIcon />
              <span className="sr-only">{t("commands.current")}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
