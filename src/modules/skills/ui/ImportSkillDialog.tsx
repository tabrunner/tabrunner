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
import { installSkillServers, type InstallOutcome } from "../install-mcp";
import { seedFromParsed, SkillForm } from "./SkillForm";

type Stage =
  | { kind: "input" }
  | { kind: "fetching" }
  | { kind: "review"; parsed: ParsedSkillMd; sourceUrl?: string }
  | {
      /** Skill already saved; this reports the consented server installs. */
      kind: "mcp-installed";
      names: string[];
      outcomes: InstallOutcome[];
    }
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
  /** Which suggested MCP servers the user opted into — defaults OFF, always. */
  const [mcpChoice, setMcpChoice] = useState<Set<number>>(new Set());
  /** True while the GitHub tree scan runs — its honest label under Fetching…'s slot. */
  const [scanning, setScanning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * State updates land next render, so `stage.kind === "input"` alone cannot
   * stop a fast double-click/Enter — two fetches or two checklist saves could
   * race past it. This ref is checked and set synchronously; it's the guard.
   */
  const busyRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const fetchIt = async () => {
    if (busyRef.current || stage.kind !== "input") return;
    busyRef.current = true;
    try {
      setError(null);
      if (!input.trim()) {
        setError(t("skills.import.errorNoUrl"));
        return;
      }
      const source = resolveSkillSource(input);
      if (!source.ok) {
        setError(
          t(
            source.reason === "http" ? "skills.import.errorHttp" : "skills.import.errorUnparseable",
          ),
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
          setScanning(true);
          const found = await discoverRepoSkills(repo.repo, controller.signal);
          setScanning(false);
          if (found.ok && found.files.length > 1) {
            const attempts = await Promise.all(
              found.files.map(async (f) => {
                try {
                  const text = await fetchSkillMarkdown(f.url, controller.signal);
                  return {
                    path: f.path,
                    url: f.url,
                    parsed: parseSkillMd(text),
                    ok: true as const,
                  };
                } catch {
                  return { path: f.path, ok: false as const };
                }
              }),
            );
            const candidates = attempts.filter((a) => a.ok).map((a) => ({ ...a }));
            const failedPaths = attempts.filter((a) => !a.ok).map((a) => a.path);
            if (candidates.length > 1) {
              setStage({
                kind: "review-multi",
                candidates,
                failedPaths,
                truncated: found.truncated,
              });
              setSelected(new Set(candidates.map((_, i) => i)));
              return;
            }
            // Exactly one survivor — review it directly, no re-fetch needed.
            const only = candidates[0];
            if (only) {
              setMcpChoice(new Set());
              setStage({ kind: "review", parsed: only.parsed, sourceUrl: only.url });
              return;
            }
          }
        }
        const text = await fetchSkillMarkdown(source.url, controller.signal);
        setMcpChoice(new Set());
        setStage({ kind: "review", parsed: parseSkillMd(text), sourceUrl: source.url });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStage({ kind: "input" });
      }
    } finally {
      busyRef.current = false;
    }
  };

  const previewPaste = () => {
    setError(null);
    if (!pasted.trim()) {
      setError(t("skills.import.errorNothingPasted"));
      return;
    }
    setMcpChoice(new Set());
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
    if (busyRef.current || stage.kind !== "review-multi") return;
    busyRef.current = true;
    try {
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
            // Stored but not offered here: credential consent inside a 25-row
            // checklist is noise. ponytail: the upgrade path is an editor-side
            // "install suggested servers" action on saved skills.
            ...(c.parsed.mcpServers.length > 0 ? { mcpServers: c.parsed.mcpServers } : {}),
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
    } finally {
      busyRef.current = false;
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
            // Status line sits IN the content column, not shrink-0 beside it —
            // "Already saved with this name — untouched…" would push wide in a
            // 30rem dialog otherwise.
            const outcomeText =
              outcome?.status === "saved"
                ? t("skills.import.rowSaved")
                : outcome?.status === "skipped-existing"
                  ? t("skills.import.rowSkippedExists")
                  : outcome?.status === "skipped-cap"
                    ? t("skills.import.rowSkippedCap")
                    : outcome
                      ? t("skills.import.rowFailed", { error: outcome.error ?? "" })
                      : null;
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
                  <p
                    className={`truncate text-sm font-semibold ${selected.has(i) || outcomes ? "" : "opacity-50"} text-neutral-900 dark:text-neutral-100`}
                    title={label}
                  >
                    {label}
                  </p>
                  <p
                    className="truncate text-[11px] text-neutral-500 dark:text-neutral-400"
                    title={c.path}
                  >
                    {c.parsed.description || c.path}
                  </p>
                  {outcome && (
                    <p
                      className={`mt-0.5 break-words text-xs ${
                        outcome.status === "saved"
                          ? "text-brand-600 dark:text-brand-400"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {outcomeText}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!!outcomes}
            className="cursor-pointer text-xs text-neutral-500 underline-offset-2 hover:underline disabled:no-underline dark:text-neutral-400"
            onClick={() =>
              setSelected(allChecked ? new Set() : new Set(stage.candidates.map((_, i) => i)))
            }
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
            <Button disabled={selected.size === 0} onClick={() => void importSelected()}>
              {settledCount > 0
                ? t("skills.import.importingSelected")
                : t("skills.import.importSelected", { count: selected.size })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  /**
   * SkillForm owns the skill's save; this wraps its success path so the
   * consented servers install right after, and the dialog reports them
   * instead of just vanishing.
   */
  const afterSkillSaved = () => {
    const nextStage = stage;
    if (nextStage.kind !== "review") return;
    const refs = nextStage.parsed.mcpServers.filter((_, i) => mcpChoice.has(i));
    if (refs.length === 0) {
      onDone();
      return;
    }
    // A storage hiccup must not strand the dialog on the review stage with no
    // word — an all-failed report routes through the same honest outcome rows.
    void installSkillServers(refs)
      .then((outcomes) =>
        setStage({
          kind: "mcp-installed",
          names: refs.map((r) => r.name),
          outcomes,
        }),
      )
      .catch(() =>
        setStage({
          kind: "mcp-installed",
          names: refs.map((r) => r.name),
          outcomes: refs.map(() => "failed" as const),
        }),
      );
  };

  if (stage.kind === "mcp-installed") {
    return (
      <div className="flex flex-col gap-3">
        {stage.names.map((name, i) => {
          const outcome = stage.outcomes[i];
          return (
            <p key={`${name}-${i}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-semibold text-neutral-900 dark:text-neutral-100">
                {name}
              </span>
              <span
                className={
                  outcome === "installed"
                    ? "shrink-0 text-brand-600 dark:text-brand-400"
                    : "shrink-0 text-neutral-500 dark:text-neutral-400"
                }
              >
                {t(
                  outcome === "installed"
                    ? "skills.import.mcpRowInstalled"
                    : outcome === "duplicate"
                      ? "skills.import.mcpRowDuplicate"
                      : "skills.import.mcpRowFailed",
                )}
              </span>
            </p>
          );
        })}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t("skills.import.mcpDoneHint")}
        </p>
        <div className="flex justify-end">
          <Button onClick={onDone}>{t("common.close")}</Button>
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
        {stage.parsed.mcpServers.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              {t("skills.import.mcpTitle")}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("skills.import.mcpConsent")}
            </p>
            {stage.parsed.mcpServers.map((server, i) => (
              <div key={`${server.name}-${i}`} className="flex items-start gap-2">
                <Switch
                  checked={mcpChoice.has(i)}
                  onChange={(v) =>
                    setMcpChoice((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(i);
                      else next.delete(i);
                      return next;
                    })
                  }
                  ariaLabel={server.name}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                    {server.name}
                  </p>
                  <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                    {server.url}
                    {server.headers &&
                      ` · ${Object.keys(server.headers)
                        .map((h) => t("skills.import.mcpHeaderMasked", { name: h }))
                        .join(", ")}`}
                  </p>
                </div>
              </div>
            ))}
            <p className="attention rounded-lg px-2 py-1.5 text-[11px] text-neutral-700 dark:text-neutral-300">
              {t("skills.import.mcpCredentialWarning")}
            </p>
          </div>
        )}
        <SkillForm
          seed={seedFromParsed(stage.parsed, stage.sourceUrl)}
          replaceOnCollision
          onSaved={afterSkillSaved}
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
      {/* Keyed like SkillForm's error: consecutive failures must visibly re-announce. */}
      {error && (
        <p key={error} className="arrive text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
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
            {t(
              stage.kind === "fetching"
                ? scanning
                  ? "skills.import.discovering"
                  : "skills.import.fetching"
                : "skills.import.fetch",
            )}
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
