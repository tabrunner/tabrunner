import { useEffect, useRef, useState } from "react";

/**
 * The editing half of an in-place rename — the read view stays with each
 * surface, because the two differ structurally: the header's title is plain
 * text a click turns into this, while the history row's sits inside the
 * open-conversation button, and an input nested in a button is invalid markup.
 * Rendering only the input lets the row swap the whole button out instead.
 *
 * Enter and blur commit, Escape reverts. Blur commits rather than cancels
 * because the gesture that ends an inline edit is usually clicking away, and
 * discarding a rename the user just typed is the more expensive mistake — Esc
 * is right there for the other intent.
 */
export function TitleInput({
  value,
  placeholder,
  onCommit,
  onCancel,
  className = "",
  "aria-label": ariaLabel,
}: {
  value: string;
  placeholder?: string;
  /** Fires once, with the trimmed text — never with the unchanged original. */
  onCommit: (title: string) => void;
  onCancel: () => void;
  className?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // Escape must not let the blur handler commit on the way out — and neither
  // must the commit Enter already made.
  const done = useRef(false);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (next === value.trim()) onCancel();
    else onCommit(next);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // The panel binds Esc to stopping a run and Enter to sending — while a
        // title is being edited, both belong to the field alone.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      className={`min-w-0 rounded border border-brand-400 bg-white px-1 py-0.5 outline-none dark:border-brand-600 dark:bg-neutral-900 ${className}`}
    />
  );
}
