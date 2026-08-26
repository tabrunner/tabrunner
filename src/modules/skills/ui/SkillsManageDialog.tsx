import { useTranslation } from "react-i18next";
import { TitledDialog } from "@/components/TitledDialog";
import { SkillsSection } from "./SkillsSection";
import { setSkillsManageOpen, useSkillsManageOpen } from "./manage-open";

/**
 * /skills's one instance in the side panel: the Settings section, whole, in a
 * modal — mounted only while open, so a visit never leaks list state. The
 * editor and import dialogs it opens portal independently and stack on top.
 */
export function SkillsManageDialog() {
  const { t } = useTranslation();
  const open = useSkillsManageOpen();
  return (
    <TitledDialog
      open={open}
      onOpenChange={setSkillsManageOpen}
      title={t("skills.manageTitle")}
      description={t("skills.manageHelp")}
      widthClass="w-[min(30rem,calc(100vw-2rem))]"
    >
      {open && <SkillsSection showHeading={false} />}
    </TitledDialog>
  );
}
