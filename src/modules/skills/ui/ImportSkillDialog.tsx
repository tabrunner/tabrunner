import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TitledDialog } from "@/components/TitledDialog";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { TextArea } from "@/components/TextArea";
import { Switch } from "@/components/Switch";
import { parseSkillMd, type ParsedSkillMd } from "../skill-md";
import {
  discoverRepoSkills,
  fetchSkillMarkdown,
  resolveGithubRepo,
  resolveSkillSource,
} from "../import-url";
import { MAX_SKILLS, normalizeSkillName } from "../types";
import { listSkills, saveSkill } from "../store";
import { seedFromParsed, SkillForm } from "./SkillForm";

type Stage =
  | { kind: "input" }
  | { kind: "fetching" }
  | { kind: "review"; parsed: ParsedSkillMd; sourceUrl?: string }
  | {
      kind: "review-multi";
      candidates: { path: string; url: string; parsed: ParsedSkillMd }[];
      failedPaths: string[];
      truncated: boolean;
    };

/** Per-row import outcome for the checklist — null until that row is settled. */
type RowOutcome = {
  status: "saved" | "skipped-existing" | "skipped-cap" | "failed";
  error?: string;
};

/**
 * The dialog's inside, mounted only while it is open (DraftBody's rule) —
 * mounting IS the reset, so closing mid-fetch can't leak that fetch's result
 * into the next open as a review stage nobody asked for. Unmount also aborts
 * the transfer itself.
 */
function ImportBody({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "input" });
  const [pasting, setPasting] = useState(false);
  const [input, setInput] = useState("");
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<(RowOutcome | null)[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const fetchIt = async () => {
    if (stage.kind !== "input") return; // Enter while a fetch is in flight
    setError(null);
    const source = resolveSkillSource(input);
    if (!source.ok) {
      setError(
        t(source.reason === "http" ? "skills.import.errorHttp" : "skills.import.errorUnparseable"),
      );
      return;
    }
    setStage({ kind: "fetching" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Repo-shaped input tries discovery first: the repo may hold many skills.
      // Anything less than two survivors degrades to the single-file flow —
      // one hit reviews in the editable form, a failed scan falls through so
      // the plain fetch answers with its own (rate-limit aware) error.
      const repo = resolveGithubRepo(input);
      if (repo.ok) {
        const found = await discoverRepoSkills(repo.repo, controller.signal);
        if (found.ok && found.files.length > 1) {
          const attempts = await Promise.all(
            found.files.map(async (f) => {
              try {
                const text = await fetchSkillMarkdown(f.url, controller.signal);
                return { path: f.path, url: f.url, parsed: parseSkillMd(text), ok: true as const };
              } catch {
                return { path: f.path, ok: false as const };
              }
            }),
          );
          const candidates = attempts.filter((a) => a.ok).map((a) => ({ ...a }));
          const failedPaths = attempts.filter((a) => !a.ok).map((a) => a.path);
          if (candidates.length > 1) {
            setStage({ kind: "review-multi", candidates, failedPaths, truncated: found.truncated });
            setSelected(new Set(candidates.map((_, i) => i)));
            return;
          }
          // Exactly one survivor — review it directly, no re-fetch needed.
          const only = candidates[0];
          if (only) {
            setStage({ kind: "review", parsed: only.parsed, sourceUrl: only.url });
            return;
          }
        }
      }
      const text = await fetchSkillMarkdown(source.url, controller.signal);
      setStage({ kind: "review", parsed: parseSkillMd(text), sourceUrl: source.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ kind: "input" });
    }
  };

  const previewPaste = () => {
    setError(null);
    if (!pasted.trim()) {
      setError(t("skills.import.errorNothingPasted"));
      return;
    }
    setStage({ kind: "review", parsed: parseSkillMd(pasted) });
  };

  /**
   * The checklist's save. Sequential through the write queue's own
   * serialization, each row fully validated; the store reports per row —
   * skipped-existing / skipped-cap / failed — and NOTHING silently takes over
   * a same-named skill (bulk replace is how one bad file wrecks a library).
   * The cap stops the batch rather than half-importing unasked.
   */
  const importSelected = async () => {
    if (stage.kind !== "review-multi") return;
    const stored = new Set((await listSkills()).map((s) => s.name));
    let count = stored.size;
    const results: (RowOutcome | null)[] = stage.candidates.map(() => null);
    setOutcomes([...results]);
    for (let i = 0; i < stage.candidates.length; i++) {
      if (!selected.has(i)) continue;
      const c = stage.candidates[i];
      if (!c) continue;
      const name = normalizeSkillName(c.parsed.name ?? "");
      let outcome: RowOutcome;
      if (!name) {
        outcome = { status: "failed", error: t("skills.errors.badName") };
      } else if (stored.has(name)) {
        outcome = { status: "skipped-existing" };
      } else if (count >= MAX_SKILLS) {
        outcome = { status: "skipped-cap" };
      } else {
        const result = await saveSkill({
          id: crypto.randomUUID(),
          name,
          description: c.parsed.description ?? "",
          sites: c.parsed.sites.length > 0 ? c.parsed.sites : undefined,
          body: c.parsed.body,
          enabled: true,
          source: { url: c.url },
        });
        if (result.ok) {
          stored.add(name);
          count++;
          outcome = { status: "saved" };
        } else {
          outcome = { status: "failed", error: result.error };
        }
      }
      results[i] = outcome;
      setOutcomes([...results]);
    }
  };

  if (stage.kind === "review-multi") {
    const allChecked = selected.size === stage.candidates.length;
    const settledCount = outcomes?.filter(Boolean).length ?? 0;
    const savedCount = outcomes?.filter((o) => o?.status === "saved").length ?? 0;
    return (
      <div className="flex flex-col gap-3">
        <p className="attention rounded-lg px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
          {t("skills.import.multiReview")}
        </p>
        {stage.truncated && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("skills.import.truncated")}
          </p>
        )}
        {stage.failedPaths.length > 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("skills.import.someFailed", { list: stage.failedPaths.join(", ") })}
          </p>
        )}
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {stage.candidates.map((c, i) => {
            const outcome = outcomes?.[i];
            const label = normalizeSkillName(c.parsed.name ?? "") ?? c.path;
            return (
              <li
                key={c.path}
                className="flex items-start gap-2 rounded-lg bg-neutral-50 px-2.5 py-2 dark:bg-neutral-900/50"
              >
                {!outcomes && (
                  <Switch
                    checked={selected.has(i)}
                    onChange={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(i);
                        else next.delete(i);
                        return next;
                      })
                    }
                    ariaLabel={label}
                    title={c.path}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold ${selected.has(i) || outcomes ? "" : "opacity-50"} text-neutral-900 dark:text-neutral-100`}>
                    {label}
                  </p>
                  <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400" title={c.path}>
                    {c.parsed.description || c.path}
                  </p>
                </div>
                {outcome && (
                  <span
                    className={
                      outcome.status === "saved"
                        ? "shrink-0 text-xs text-brand-600 dark:text-brand-400"
                        : "shrink-0 text-xs text-neutral-500 dark:text-neutral-400"
                    }
                  >
                    {outcome.status === "saved"
                      ? t("skills.import.rowSaved")
                      : outcome.status === "skipped-existing"
                        ? t("skills.import.rowSkippedExists")
                        : outcome.status === "skipped-cap"
                          ? t("skills.import.rowSkippedCap")
                          : t("skills.import.rowFailed", { error: outcome.error ?? "" })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!!outcomes}
            className="cursor-pointer text-xs text-neutral-500 underline-offset-2 hover:underline disabled:no-underline dark:text-neutral-400"
            onClick={() => setSelected(allChecked ? new Set() : new Set(stage.candidates.map((_, i) => i)))}
          >
            {allChecked ? t("skills.import.selectNone") : t("skills.import.selectAll")}
          </button>
          {outcomes ? (
            <Button onClick={() => (savedCount > 0 ? onDone() : setStage({ kind: "input" }))}>
              {savedCount > 0
                ? t("skills.import.multiDone", { count: savedCount })
                : t("common.cancel")}
            </Button>
          ) : (
            <Button
              disabled={selected.size === 0}
              onClick={() => void importSelected()}
            >
              {settledCount > 0
                ? t("skills.import.importingSelected")
                : t("skills.import.importSelected", { count: selected.size })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (stage.kind === "review") {
    return (
      <div className="flex flex-col gap-3">
        <p className="attention rounded-lg px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
          {t("skills.import.review")}
        </p>
        {stage.parsed.ignoredKeys.length > 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("skills.import.ignored", { list: stage.parsed.ignoredKeys.join(", ") })}
          </p>
        )}
        {stage.parsed.droppedSites.length > 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("skills.import.droppedSites", { list: stage.parsed.droppedSites.join(", ") })}
          </p>
        )}
        <SkillForm
          seed={seedFromParsed(stage.parsed, stage.sourceUrl)}
          replaceOnCollision
          onSaved={onDone}
          onCancel={() => setStage({ kind: "input" })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {pasting ? (
        <TextArea
          rows={8}
          value={pasted}
          placeholder={t("skills.import.pastePlaceholder")}
          onChange={(e) => setPasted(e.target.value)}
        />
      ) : (
        <TextField
          label={t("skills.import.url")}
          hint={t("skills.import.urlHint")}
          value={input}
          placeholder="https://… or owner/repo"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void fetchIt();
          }}
        />
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="cursor-pointer text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          onClick={() => {
            setPasting((v) => !v);
            setError(null);
          }}
        >
          {t(pasting ? "skills.import.modeUrl" : "skills.import.modePaste")}
        </button>
        {pasting ? (
          <Button onClick={previewPaste}>{t("skills.import.preview")}</Button>
        ) : (
          <Button disabled={stage.kind === "fetching"} onClick={() => void fetchIt()}>
            {t(stage.kind === "fetching" ? "skills.import.fetching" : "skills.import.fetch")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Import a skill from a URL, a GitHub `owner/repo` shorthand, or pasted
 * markdown. The review stage is the consent gate: an imported body is
 * untrusted prose that will ride the system prompt on matching runs, so the
 * whole of it sits in an editable form before anything is stored. The fetch
 * runs right here in the page (the `/usage` precedent) — user-initiated, one
 * URL, never from the worker.
 */
export function ImportSkillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <TitledDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("skills.import.title")}
      description={t("skills.import.description")}
      widthClass="w-[min(30rem,calc(100vw-2rem))]"
    >
      {open && <ImportBody onDone={onClose} />}
    </TitledDialog>
  );
}
