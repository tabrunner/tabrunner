import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A command to paste, with a button that copies it. The command is data, so it wears mono and is
 * never translated. It wraps instead of scrolling, so the whole command can be read before it is
 * pasted into a terminal. The button answers at once ("Copied" for a moment, then back to
 * "Copy"). When the browser refuses the clipboard, the command is selected and a line says so, so
 * the reader knows to press Ctrl+C themselves.
 */
export function CodeBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => setState("copied"),
      () => {
        if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
        setState("failed");
      },
    );
  };

  return (
    <div className="mt-3">
      <div className="flex items-start gap-3 rounded-xl border border-field-600/60 bg-field-800/60 py-2 pr-2 pl-4">
        <pre className="min-w-0 flex-1 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-star-100 [overflow-wrap:anywhere] sm:text-sm">
          <code ref={codeRef}>{code}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-11 min-w-16 shrink-0 items-center justify-center rounded-full border border-field-500 px-3 text-xs font-semibold text-star-100 transition-colors hover:border-flare-500/60 hover:text-flare-300 active:scale-[0.97] sm:min-h-8"
        >
          {state === "copied" ? t("docs.copied") : t("docs.copy")}
        </button>
      </div>
      <p role="status" className={state === "failed" ? "mt-2 text-sm text-star-300" : "sr-only"}>
        {state === "copied" ? t("docs.copied") : state === "failed" ? t("docs.copyFailed") : ""}
      </p>
    </div>
  );
}
