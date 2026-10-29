import { useTranslation } from "react-i18next";
import { TitledDialog } from "@/components/TitledDialog";
import type { Skill } from "../types";
import { SkillForm } from "./SkillForm";

/** New/Edit dialog on the options page — a thin shell around the one SkillForm. */
export function SkillEditorDialog({
  open,
  skill,
  onClose,
}: {
  open: boolean;
  /** Present = edit this skill; absent = create a new one. */
  skill?: Skill;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TitledDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={skill ? t("skills.editTitle", { name: skill.name }) : t("skills.newTitle")}
      widthClass="w-[min(30rem,calc(100vw-2rem))]"
    >
      {/* Keyed so switching between rows never leaks one skill's draft state into another's. */}
      <SkillForm key={skill?.id ?? "new"} seed={skill} onSaved={onClose} onCancel={onClose} />
    </TitledDialog>
  );
}
