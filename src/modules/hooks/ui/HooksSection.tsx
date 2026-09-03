import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";
import { TextField } from "@/components/TextField";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PencilIcon, PlusIcon, TrashIcon } from "@/components/Icon";
import { TitledDialog } from "@/components/TitledDialog";
import { useStoredItem } from "@/components/useStoredItem";
import { HOOK_EVENTS, MAX_HOOKS, type HookEvent, type HookRule } from "../types";
import { deleteHook, hookRulesItem, saveHook, setHookEnabled } from "../store";

const EVENT_KEY = {
  run_started: "hooks.events.run_started",
  run_finished: "hooks.events.run_finished",
  ask_user: "hooks.events.ask_user",
  error: "hooks.events.error",
} as const;

/**
 * Settings → Behavior, webhooks: rules that POST run-lifecycle events out to
 * a user URL. Rows carry their own last-delivery receipt, so "is this thing
 * even firing" is answered where the rule lives, not in a network tab.
 */
export function HooksSection() {
  const { t } = useTranslation();
  const rules = useStoredItem(hookRulesItem);
  const [editor, setEditor] = useState<{ open: boolean; rule?: HookRule }>({ open: false });

  return (
    <section className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("hooks.title")}
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("hooks.help")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={rules.length >= MAX_HOOKS}
          onClick={() => setEditor({ open: true })}
        >
          <PlusIcon /> {t("hooks.add")}
        </Button>
      </div>

      {rules.length === 0 ? (
        <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-3 dark:bg-neutral-900/50">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("hooks.empty")}</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50"
            >
              <div className={`min-w-0 flex-1 ${rule.enabled ? "" : "opacity-50"}`}>
                <span className="rounded bg-neutral-200/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {rule.event}
                </span>
                <p className="mt-1 truncate font-mono text-xs text-neutral-600 dark:text-neutral-300">
                  {rule.url.replace(/^https?:\/\//, "")}
                </p>
                <Receipt rule={rule} />
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                <Switch
                  checked={rule.enabled}
                  onChange={(v) => void setHookEnabled(rule.id, v)}
                  ariaLabel={t("hooks.enable")}
                  title={t("hooks.enable")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("hooks.edit")}
                  title={t("hooks.edit")}
                  onClick={() => setEditor({ open: true, rule })}
                >
                  <PencilIcon />
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      aria-label={t("hooks.delete")}
                      title={t("hooks.delete")}
                    >
                      <TrashIcon />
                    </Button>
                  }
                  title={t("hooks.deleteTitle")}
                  description={t("hooks.deleteDescription")}
                  onConfirm={() => void deleteHook(rule.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Mounted only while open — the form state must reset between opens,
          same contract as every other add/edit dialog here. */}
      {editor.open && (
        <HookDialog
          {...(editor.rule ? { rule: editor.rule } : {})}
          onClose={() => setEditor({ open: false })}
        />
      )}
    </section>
  );
}

function Receipt({ rule }: { rule: HookRule }) {
  const { t } = useTranslation();
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const r = rule.lastDelivery;
  if (!r) {
    return (
      <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        {t("hooks.receiptNever")}
      </p>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
      {r.ok ? (
        <>
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>{" "}
          {t("hooks.receipt", { at: time(r.at), status: String(r.status ?? "") })}
        </>
      ) : (
        <>
          <span className="text-red-500">✗</span> {t("hooks.receiptFailed", { at: time(r.at) })}
        </>
      )}
    </p>
  );
}

function HookDialog({
  rule,
  onClose,
}: {
  /** Present = edit; absent = create. */
  rule?: HookRule;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<HookEvent>(rule?.event ?? "run_finished");
  const [url, setUrl] = useState(rule?.url ?? "");
  const [error, setError] = useState<string | null>(null);

  return (
    <TitledDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={rule ? t("hooks.editTitle") : t("hooks.newTitle")}
      description={t("hooks.dialogHelp")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void saveHook({ ...(rule ? { id: rule.id } : {}), event, url }).then((saved) => {
            if (saved.ok) onClose();
            else setError(saved.error);
          });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {t("hooks.eventLabel")}
          </span>
          <select
            className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            value={event}
            onChange={(e) => setEvent(e.target.value as HookEvent)}
          >
            {HOOK_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {t(EVENT_KEY[ev])}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label={t("hooks.urlLabel")}
          hint={
            <>
              {t("hooks.urlHint")} {t("hooks.headersHint")}
            </>
          }
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/tabrunner"
          spellCheck={false}
        />

        {error && (
          <p className="arrive text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!url.trim()} type="submit">
            {t("hooks.save")}
          </Button>
        </div>
      </form>
    </TitledDialog>
  );
}
