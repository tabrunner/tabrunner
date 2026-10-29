import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TitledDialog } from "@/components/TitledDialog";
import { Button } from "@/components/Button";
import { getMessages } from "@/modules/conversation";
import {
  ensureProviderCredential,
  getActiveProvider,
  resolveProviderModel,
} from "@/modules/providers";
import { i18n } from "@/i18n";
import { distillSkillDraft } from "../distill";
import { seedFromParsed, SkillForm, type SkillSeed } from "./SkillForm";
import { setSkillDraftOpen, useSkillDraftOpen } from "./draft-open";

type Stage =
  { kind: "working" } | { kind: "review"; seed: SkillSeed } | { kind: "error"; message: string };

/** The whole pipeline, component-free: transcript → provider → SKILL.md draft → form seed. */
async function distillFor(conversationId: string | null, signal: AbortSignal): Promise<SkillSeed> {
  if (!conversationId) throw new Error(i18n.t("skills.draft.errorNothing"));
  const transcript = await getMessages(conversationId);
  const config = await getActiveProvider();
  // Unreachable — the panel onboards instead of rendering a composer when no
  // provider exists — but a raw crash is worse than a guard.
  if (!config) throw new Error(i18n.t("skills.draft.errorNothing"));
  const resolved = await resolveProviderModel(await ensureProviderCredential(config));
  return seedFromParsed(await distillSkillDraft(resolved, transcript, signal));
}

/**
 * The dialog's inside, mounted only while it is open — mounting IS the reset,
 * so a reopen never shows the last attempt's leftovers, and unmount aborts a
 * distillation nobody is waiting for. Retry bumps `attempt` to re-run the one
 * effect; its cleanup is what cancels the superseded call.
 */
function DraftBody({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "working" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    distillFor(conversationId, controller.signal).then(
      (seed) => {
        if (!controller.signal.aborted) setStage({ kind: "review", seed });
      },
      (e: unknown) => {
        if (!controller.signal.aborted)
          setStage({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => controller.abort();
  }, [conversationId, attempt]);

  if (stage.kind === "working") {
    return (
      <p className="animate-pulse py-6 text-center text-sm text-neutral-500 motion-reduce:animate-none dark:text-neutral-400">
        {t("skills.draft.working")}
      </p>
    );
  }
  if (stage.kind === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {stage.message}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setStage({ kind: "review", seed: {} })}>
            {t("skills.draft.manual")}
          </Button>
          <Button
            onClick={() => {
              setStage({ kind: "working" });
              setAttempt((a) => a + 1);
            }}
          >
            {t("skills.draft.retry")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SkillForm
      seed={stage.seed}
      onSaved={() => setSkillDraftOpen(false)}
      onCancel={() => setSkillDraftOpen(false)}
    />
  );
}

/**
 * `/skill new` — distill the open conversation into a draft skill and review
 * it before anything is stored. Rendered once by the side panel's App, which
 * passes the active conversation id (a prop, not a store import, so skills/ui
 * never depends back on conversation/ui). The distillation runs right here in
 * the panel page: nothing persists until Save, and with the panel closed
 * there is nobody left to review — so worker-side survival would buy nothing.
 */
export function SkillDraftDialog({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation();
  const open = useSkillDraftOpen();

  return (
    <TitledDialog
      open={open}
      onOpenChange={setSkillDraftOpen}
      title={t("skills.draft.title")}
      description={t("skills.draft.description")}
    >
      {open && <DraftBody conversationId={conversationId} />}
    </TitledDialog>
  );
}
