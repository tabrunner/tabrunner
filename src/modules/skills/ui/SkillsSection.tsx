import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { CometPose } from "@/components/CometPose";
import { Switch } from "@/components/Switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CheckIcon, Icon, PencilIcon, TrashIcon } from "@/components/Icon";
import { useStoredItem } from "@/components/useStoredItem";
import type { Skill } from "../types";
import { deleteSkill, setSkillEnabled, skillsItem } from "../store";
import { serializeSkillMd } from "../skill-md";
import { SkillEditorDialog } from "./SkillEditorDialog";
import { ImportSkillDialog } from "./ImportSkillDialog";

/** Used only here — stays local, per Icon.tsx's rule. */
function CopyIcon() {
  return (
    <Icon>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Icon>
  );
}

/**
 * Settings → Skills: the saved recipes, each a row with its scope and switch;
 * creating, editing, importing and exporting all happen here. The chat-side
 * doors (`/skills`, `/skill new`) are the fast path — this page is the place
 * the whole library is reviewed, like Knowledge is for memory. Also mounted,
 * heading-less, inside the /skills modal (`showHeading={false}`).
 */
export function SkillsSection({ showHeading = true }: { showHeading?: boolean }) {
  const { t } = useTranslation();
  const skills = useStoredItem(skillsItem);
  const [editor, setEditor] = useState<{ open: boolean; skill?: Skill }>({ open: false });
  const [importing, setImporting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef(0);

  const exportSkill = (skill: Skill) => {
    void navigator.clipboard.writeText(serializeSkillMd(skill)).then(() => {
      setCopiedId(skill.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1_600);
    });
  };

  return (
    <section className={showHeading ? "mt-8" : undefined}>
      <div className={`flex items-start gap-4 ${showHeading ? "justify-between" : "justify-end"}`}>
        {showHeading && (
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {t("skills.title")}
            </h2>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("skills.help")}
            </p>
          </div>
        )}
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
            {t("skills.importButton")}
          </Button>
          <Button size="sm" onClick={() => setEditor({ open: true })}>
            {t("skills.newButton")}
          </Button>
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-3 dark:bg-neutral-900/50">
          <CometPose pose="resting" size={40} className="shrink-0" />
          <p className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">
            {t("skills.empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex items-start justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50"
            >
              <div className={`min-w-0 flex-1 ${skill.enabled ? "" : "opacity-50"}`}>
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {skill.name}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {skill.description}
                </p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {skill.sites?.length ? (
                    skill.sites.map((site) => (
                      <span
                        key={site}
                        className="rounded bg-neutral-200/70 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                      >
                        {site}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {t("skills.everySite")}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                <Switch
                  checked={skill.enabled}
                  onChange={(v) => void setSkillEnabled(skill.id, v)}
                  ariaLabel={t("skills.enable")}
                  title={t("skills.enable")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("skills.edit")}
                  title={t("skills.edit")}
                  onClick={() => setEditor({ open: true, skill })}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("skills.export")}
                  title={copiedId === skill.id ? t("skills.copied") : t("skills.export")}
                  onClick={() => exportSkill(skill)}
                >
                  {copiedId === skill.id ? <CheckIcon className="arrive" /> : <CopyIcon />}
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      aria-label={t("skills.delete")}
                      title={t("skills.delete")}
                    >
                      <TrashIcon />
                    </Button>
                  }
                  title={t("skills.deleteTitle", { name: skill.name })}
                  description={t("skills.deleteDescription")}
                  onConfirm={() => void deleteSkill(skill.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <SkillEditorDialog
        open={editor.open}
        {...(editor.skill ? { skill: editor.skill } : {})}
        onClose={() => setEditor({ open: false })}
      />
      <ImportSkillDialog open={importing} onClose={() => setImporting(false)} />
    </section>
  );
}
