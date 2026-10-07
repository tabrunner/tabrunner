import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { useWalkAway } from "./hooks";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";

/** Two windows, the far one whole — the work carries on behind what you're doing. */
function BackgroundIcon() {
  return (
    <Icon>
      <rect x="8" y="3" width="13" height="13" rx="2" />
      <path d="M16 19v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h1" />
    </Icon>
  );
}

/** The same pair, mirrored: the near window whole — the work is in front of you. */
function ForegroundIcon() {
  return (
    <Icon>
      <rect x="3" y="8" width="13" height="13" rx="2" />
      <path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" />
    </Icon>
  );
}

/**
 * Whether the next run happens in front of you or behind you, as the composer
 * card's left anchor. Two states, so a click flips it — no popup for one bit of
 * information. The current mode is the label (self-explanatory); the tooltip
 * says what the other mode does.
 *
 * It sits after the engine picker and takes whatever width the picker leaves
 * (a size container), so a narrow panel drops the label and keeps the icon
 * before the model name loses a letter. The icon still says which mode it is,
 * and the tooltip and the aria-label name it in words.
 *
 * It says nothing about which page, because the answer never differed: every
 * run works the tab you're on. What the toggle sets is whether the panel stays
 * open once you approve the plan — and, with it, whether the run may bring a
 * tab it switches to forward.
 *
 * Once a run of this panel's own is live the question is settled — it is
 * already on its tab, and nothing a toggle says can move it. So the control
 * becomes the one move still on the table: leave it to work alone. The move
 * is on the table in every live state except one: parked on the user's answer
 * (a plan gate or a server's question), where closing would strand it on an
 * OS notification — so the button is disabled there and the tooltip says why,
 * rather than leaving a dead grey button unexplained. It goes back to being a
 * preference the moment the run ends.
 */
export function RunModeToggle() {
  const { t } = useTranslation();
  const runMode = useConversationStore((s) => s.runMode);
  const setRunMode = useConversationStore((s) => s.setRunMode);
  const { live, parked } = useWalkAway();
  const foreground = runMode === "foreground";
  const mode = t(foreground ? "run.foreground" : "run.background");
  const state = t("run.modeAria", { mode });

  // The label shows once the slot can hold the longest wording of its state
  // ("Ejecutar en segundo plano" is wider than "En primer plano"). Literal
  // class names, so Tailwind sees both.
  return (
    <div className="@container flex min-w-8 flex-1">
      {live ? (
        <Button
          type="button"
          variant="quiet-brand"
          size="sm"
          disabled={parked}
          // Deliberately no setRunMode: this is an act on the run in flight,
          // not a vote on where the next one goes — so it dresses as the action
          // it is (brand, pressable), not the preference it was a second ago.
          onClick={() => window.close()}
          aria-label={t("run.backgroundNow")}
          title={t(parked ? "run.backgroundNowGated" : "run.backgroundNowTitle")}
          className="flex items-center gap-1.5"
        >
          <BackgroundIcon />
          <span className="hidden truncate @[12.5rem]:inline">{t("run.backgroundNow")}</span>
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRunMode(foreground ? "background" : "foreground")}
          aria-label={state}
          title={`${state}\n${t("run.modeTitle")}`}
          className="flex items-center gap-1.5 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {foreground ? <ForegroundIcon /> : <BackgroundIcon />}
          <span className="hidden truncate @[9.5rem]:inline">{mode}</span>
        </Button>
      )}
    </div>
  );
}
