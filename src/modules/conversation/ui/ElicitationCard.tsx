import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";
import type { ElicitationAsk } from "@/shared/protocol";

/**
 * The plan-approval card's twin for remote servers: an MCP elicitation parked
 * mid-tool-call. Fields render from the server's JSON Schema — primitives only;
 * a field the form cannot honestly render just doesn't appear, and accepting
 * sends only what it showed. What the user sees is exactly what the server gets.
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

export function ElicitationCard({
  ask,
  onAnswer,
}: {
  ask: ElicitationAsk;
  onAnswer: (action: "accept" | "decline", value?: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const fields = fieldsFrom(ask.requestedSchema);
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  const collect = (): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name];
      if (v === undefined || v === "") continue;
      value[f.name] = f.kind === "number" ? Number(v) : v;
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
        {fields.map((f) => (
          <label key={f.name} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate font-mono text-neutral-500 dark:text-neutral-400">
              {f.name}
            </span>
            {f.kind === "boolean" ? (
              <Switch
                checked={values[f.name] === true}
                onChange={(v) => setValues({ ...values, [f.name]: v })}
                ariaLabel={f.name}
              />
            ) : f.values ? (
              <select
                className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-800 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                value={typeof values[f.name] === "string" ? (values[f.name] as string) : ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              >
                <option value="">—</option>
                {f.values!.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1 font-mono text-xs text-neutral-800 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                value={typeof values[f.name] === "string" ? (values[f.name] as string) : ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                {...(f.kind === "number" ? { inputMode: "numeric" as const } : {})}
              />
            )}
          </label>
        ))}
      </div>

      <div className="mt-0.5 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => onAnswer("decline")}>
          {t("mcpOut.elicitDecline")}
        </Button>
        <Button size="sm" onClick={() => onAnswer("accept", collect())}>
          {t("mcpOut.elicitAccept")}
        </Button>
      </div>
    </div>
  );
}
