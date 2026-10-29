import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { inputChrome } from "@/components/FieldShell";
import { Switch } from "@/components/Switch";
import type { ElicitationAsk } from "@/shared/protocol";

/**
 * The plan-approval card's twin for remote servers: an MCP elicitation parked
 * mid-tool-call. Fields render from the server's JSON Schema — primitives only;
 * a field the form cannot honestly render just doesn't appear, and accepting
 * sends only what it showed. What the user sees is exactly what the server
 * gets — and what it marked required is marked here, with Send held until
 * those fields are filled (a required field the form cannot render never
 * blocks: it isn't on the card, so it isn't the user's to fill).
 */

interface RenderableField {
  name: string;
  kind: "string" | "number" | "boolean";
  values?: string[];
}

function fieldsFrom(schema: Record<string, unknown> | undefined): RenderableField[] {
  const props = schema?.properties;
  if (typeof props !== "object" || props === null) return [];
  const out: RenderableField[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    if (out.length >= 8) break; // a question card is scannable or it isn't
    if (typeof raw !== "object" || raw === null) continue;
    const def = raw as Record<string, unknown>;
    if (def.type === "boolean") {
      out.push({ name, kind: "boolean" });
    } else if (def.type === "number" || def.type === "integer") {
      out.push({ name, kind: "number" });
    } else if (
      def.type === "string" &&
      Array.isArray(def.enum) &&
      def.enum.every((v) => typeof v === "string")
    ) {
      out.push({ name, kind: "string", values: def.enum as string[] });
    } else if (def.type === "string" || def.enum !== undefined) {
      out.push({ name, kind: "string" });
    }
  }
  return out;
}

/** The schema's `required` names, when it names any. */
function requiredNames(schema: Record<string, unknown> | undefined): Set<string> {
  const names = schema?.required;
  return new Set(
    Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [],
  );
}

export function ElicitationCard({
  ask,
  onAnswer,
}: {
  ask: ElicitationAsk;
  onAnswer: (action: "accept" | "decline", value?: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const fields = fieldsFrom(ask.requestedSchema);
  const required = requiredNames(ask.requestedSchema);
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  /** A touched toggle counts even when toggled back off — the answer was deliberate. */
  const filled = (f: RenderableField): boolean => {
    const v = values[f.name];
    if (f.kind === "boolean") return v !== undefined;
    if (v === undefined || v === "") return false;
    return f.kind !== "number" || Number.isFinite(Number(v));
  };
  const readyToSend = fields.filter((f) => required.has(f.name)).every((f) => filled(f));

  const collect = (): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === undefined || v === "") continue;
      if (f.kind === "number") {
        const n = Number(v);
        // A half-typed number ("12a") reads as an unfilled field — it must
        // not go out as JSON null.
        if (!Number.isFinite(n)) continue;
        value[f.name] = n;
      } else {
        value[f.name] = v;
      }
    }
    return value;
  };

  return (
    <div className="flex max-w-[85%] flex-col gap-2 self-start rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/60">
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
        {t("mcpOut.elicitTitle", { server: ask.serverName })}
      </div>
      {ask.message && (
        <p className="text-xs whitespace-pre-wrap text-neutral-600 dark:text-neutral-300">
          {ask.message}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {fields.map((f) => {
          const v = values[f.name];
          const str = typeof v === "string" ? v : "";
          // Aliased so narrowing survives into the option-map callback.
          const options = f.values;
          return (
            <label key={f.name} className="flex items-center gap-2 text-xs">
              {/* Wide enough for an ordinary schema key ("include_attachments"
                  fits) — the marker sits outside the truncating name so it can
                  never be the part that gets cut. */}
              <span className="flex w-36 shrink-0 items-center gap-1">
                <span className="min-w-0 truncate font-mono text-neutral-500 dark:text-neutral-400">
                  {f.name}
                </span>
                {required.has(f.name) && (
                  <span
                    className="shrink-0 text-neutral-400 dark:text-neutral-500"
                    title={t("mcpOut.elicitRequired")}
                  >
                    *
                  </span>
                )}
              </span>
              {f.kind === "boolean" ? (
                <Switch
                  checked={v === true}
                  onChange={(next) => setValues({ ...values, [f.name]: next })}
                  ariaLabel={f.name}
                />
              ) : options ? (
                <select
                  className={`${inputChrome} min-w-0 flex-1 px-2 py-1 text-xs text-neutral-800 dark:text-neutral-200`}
                  value={str}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  <option value="">{t("common.selectPlaceholder")}</option>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={`${inputChrome} min-w-0 flex-1 px-2 py-1 font-mono text-xs text-neutral-800 dark:text-neutral-200`}
                  value={str}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  {...(f.kind === "number" ? { inputMode: "numeric" as const } : {})}
                />
              )}
            </label>
          );
        })}
      </div>

      {/* Same footer as the plan card it twins — primary then ghost, on the
          left where the eye entered the card — so both gates answer with the
          same motor pattern. */}
      <div className="mt-0.5 flex gap-2">
        <Button
          size="sm"
          onClick={() => onAnswer("accept", collect())}
          disabled={!readyToSend}
          title={readyToSend ? undefined : t("mcpOut.elicitRequired")}
        >
          {t("mcpOut.elicitAccept")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAnswer("decline")}>
          {t("mcpOut.elicitDecline")}
        </Button>
      </div>
    </div>
  );
}
