import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CYCLE_MS,
  DONE_AT,
  PLAN_AT,
  TOOL_AT,
  formatElapsed,
  phaseAt,
  stepStateAt,
  tokensAt,
} from "./runPhase";

/**
 * A simulated agent run, Claude Code-style: plan, tool calls, live elapsed
 * time and token spend. Labelled as a demo — it proves the interface, not a
 * fake result. One clock drives everything (see runPhase.ts); reduced motion
 * gets the finished state, which is still the honest summary of a run.
 */

/** Step markers — authored SVG, not unicode glyphs (DESIGN.md). */
function StepMark({ state }: { state: "done" | "active" | "pending" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0"
      aria-hidden="true"
    >
      {state === "done" && <path d="m3.5 8.5 3 3 6-7" />}
      {state === "active" && <path d="m6.5 4.5 4 3.5-4 3.5" />}
      {state === "pending" && <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function RunConsole() {
  const { t } = useTranslation();
  const plan = t("run.plan", { returnObjects: true }) as string[];
  const tools = t("run.tools", { returnObjects: true }) as Array<{ tool: string; detail: string }>;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTick(DONE_AT + 1); // the finished run, static
      return;
    }
    let start = performance.now();
    const id = setInterval(() => {
      setTick((performance.now() - start) % CYCLE_MS);
    }, 100);
    const onVisibility = () => {
      if (!document.hidden) start = performance.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const phase = phaseAt(tick);
  const done = phase.kind === "done";
  const tokens = tokensAt(tick);

  return (
    <div
      className="min-w-0 rounded-2xl border border-field-500/60 bg-field-800/70 shadow-[0_0_48px_-12px] shadow-flare-500/25 backdrop-blur-sm"
      role="img"
      aria-label={`${t("run.demoBadge")}: ${t("run.task")}`}
    >
      {/* header: the run's identity */}
      <div className="flex items-center gap-3 border-b border-field-600/60 px-5 py-3.5">
        <span
          className={`size-2 shrink-0 rounded-full ${
            done ? "bg-flare-400" : "live-dot bg-tel-400"
          }`}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate text-sm text-star-100">
          <span className="mr-2 font-mono text-[11px] tracking-wider text-star-500 uppercase">
            {t("run.taskLabel")}
          </span>
          {t("run.task")}
        </p>
        <span className="shrink-0 rounded-full border border-tel-400/40 px-2 py-0.5 font-mono text-[10px] tracking-wider text-tel-300 uppercase">
          {t("run.demoBadge")}
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* status line */}
        <p className="font-mono text-sm">
          {phase.kind === "done" ? (
            <span className="text-flare-300">{t("run.done")}</span>
          ) : (
            <span className="shimmer-text">
              {phase.kind === "planning"
                ? t("run.planning")
                : phase.kind === "composing"
                  ? t("run.composing")
                  : plan[phase.index]}
            </span>
          )}
        </p>

        {/* plan */}
        {tick >= PLAN_AT && (
          <div>
            <p className="font-mono text-[11px] tracking-wider text-star-500 uppercase">
              {t("run.planTitle")}
            </p>
            <ol className="mt-1.5 space-y-1">
              {plan.map((step, i) => {
                const state = stepStateAt(tick, i);
                return (
                  <li key={step} className="flex items-center gap-2 text-sm">
                    <span
                      className={
                        state === "done"
                          ? "text-flare-400"
                          : state === "active"
                            ? "text-tel-400"
                            : "text-star-500"
                      }
                    >
                      <StepMark state={state} />
                    </span>
                    <span
                      className={
                        state === "done"
                          ? "text-star-500 line-through"
                          : state === "active"
                            ? "text-star-100"
                            : "text-star-500"
                      }
                    >
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {/* tool calls */}
        <div className="space-y-1 font-mono text-xs" aria-hidden="true">
          {tools.map((line, i) =>
            tick >= TOOL_AT[i] ? (
              <p key={line.tool}>
                <span className="text-flare-400">{line.tool}</span>{" "}
                <span className="text-star-500">{line.detail}</span>
              </p>
            ) : null,
          )}
        </div>
      </div>

      {/* telemetry: amber measures */}
      <div className="flex items-center justify-between border-t border-field-600/60 px-5 py-3 font-mono text-xs text-tel-300">
        <span className="tnum">
          {formatElapsed(Math.min(tick, DONE_AT))} {t("run.elapsed")}
        </span>
        <span className="tnum">
          {tokens.toLocaleString()} {t("run.tokens")}
        </span>
      </div>
    </div>
  );
}
