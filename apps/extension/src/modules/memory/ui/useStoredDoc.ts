import { useEffect, useRef, useState } from "react";
import { getDoc, setDoc, watchDoc } from "../documents";
import type { DocName } from "../documents";

/** Long enough that a save feels instant, short enough to survive a closed tab. */
const SAVE_DEBOUNCE_MS = 500;
const SAVED_BADGE_MS = 1_600;

const timers = new Map<DocName, number>();

/**
 * One stored document edited as free text, autosaved. Reloads on doc switch and
 * follows background writes — but never while the user is typing into the field,
 * or a mid-run `remember` would eat their edit.
 */
export function useStoredDoc(name: DocName) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    void getDoc(name).then((v) => live && setText(v));
    const unwatch = watchDoc(name, (v) => {
      if (live && document.activeElement !== ref.current) setText(v);
    });
    return () => {
      live = false;
      unwatch();
    };
  }, [name]);

  const write = (value: string) => {
    setText(value);
    void setDoc(name, value).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), SAVED_BADGE_MS);
    });
  };

  // Debounced so a burst of keystrokes is one storage write, not thirty.
  const edit = (value: string) => {
    setText(value);
    clearTimeout(timers.get(name));
    timers.set(
      name,
      window.setTimeout(() => write(value), SAVE_DEBOUNCE_MS),
    );
  };

  return { text, saved, ref, edit, write };
}
