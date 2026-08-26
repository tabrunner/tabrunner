/**
 * The tip list, as data. Each id is a key under the `tips` object in the i18n
 * catalogs — the copy lives there, this file owns identity and cadence.
 * `cooldownOpens` is measured in panel opens (Claude Code measures in app
 * startups; our "session" is a panel open), so the short-cooldown tips are the
 * core shortcuts worth repeating and the long ones are the niche features.
 * Keep the copy to one idea, ≤ ~90 chars — TipLine clamps at two lines.
 */
export const TIPS = [
  { id: "escStop", cooldownOpens: 4 },
  { id: "historyRecall", cooldownOpens: 4 },
  { id: "foreground", cooldownOpens: 4 },
  { id: "queueSteer", cooldownOpens: 4 },
  { id: "slashCommands", cooldownOpens: 4 },
  { id: "help", cooldownOpens: 4 },
  { id: "pasteImage", cooldownOpens: 6 },
  { id: "pasteCollapse", cooldownOpens: 6 },
  { id: "planApproval", cooldownOpens: 6 },
  { id: "planExpand", cooldownOpens: 4 },
  { id: "widget", cooldownOpens: 6 },
  { id: "board", cooldownOpens: 6 },
  { id: "memory", cooldownOpens: 8 },
  { id: "siteInstructions", cooldownOpens: 8 },
  { id: "schedule", cooldownOpens: 8 },
  { id: "skills", cooldownOpens: 8 },
  { id: "skillsManage", cooldownOpens: 8 },
  { id: "walkthrough", cooldownOpens: 6 },
  { id: "usage", cooldownOpens: 8 },
  { id: "compact", cooldownOpens: 8 },
  { id: "enginePicker", cooldownOpens: 6 },
  { id: "engineScope", cooldownOpens: 8 },
  { id: "mcpOut", cooldownOpens: 8 },
  { id: "webhooks", cooldownOpens: 8 },
] as const;

export type TipId = (typeof TIPS)[number]["id"];
