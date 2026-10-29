import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDER_PRESETS } from "../lib/links";
import { CometMark } from "./CometMark";

/**
 * The Route — the features section as a signal-path schematic, not a grid of
 * icon cards. One task's journey down a single spine: you (or an MCP client)
 * → the extension → your provider → the guardrails gate → the page. The two
 * claims a sandboxed competitor cannot copy become topology instead of
 * assertions: the provider hop is direct, and the relay server is a ghost
 * station on a dashed spur — the stop this line does not make. Each feature
 * annotates the station where it acts; the evidence (the real preset list,
 * the real ref lines) rides its station. Nothing here glows or moves: the
 * map is an instrument at rest, and the comet launch stays the page's one
 * authored moment. Desktop reads as a centered metro map with annotations
 * alternating sides; mobile collapses to a left rail with the same stops.
 */

type Item = { title: string; body: string };

/** A station name on the spine — mono, because these are entity labels. */
function Chip({
  tone = "default",
  children,
}: {
  tone?: "default" | "hub" | "gate" | "ghost";
  children: ReactNode;
}) {
  const tones = {
    default: "rounded-full border-field-500/60 text-star-300",
    hub: "rounded-full border-flare-500/50 text-flare-300",
    gate: "rounded-md border-field-500/60 text-star-100",
    ghost: "rounded-full border-dashed border-field-500/60 text-star-500",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 border bg-field-900 px-3 py-1 font-mono text-[11px] tracking-wider uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** One stop on the line: a metro dot on the rail (mobile) or the chip astride the spine (lg). */
function Station({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex items-center gap-3 py-1 pl-10 lg:col-start-2 lg:row-start-1 lg:justify-center lg:py-2 lg:pl-0">
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-[7px] size-3 -translate-y-1/2 rounded-full border-2 border-flare-500/70 bg-field-900 lg:hidden"
      />
      {children}
    </div>
  );
}

/** A feature annotation hanging off its station, alternating sides on lg. */
function Note({
  item,
  side,
  children,
}: {
  item: Item;
  side: "left" | "right";
  children?: ReactNode;
}) {
  return (
    <div
      className={`mt-3 min-w-0 pl-10 lg:row-start-1 lg:mt-0 lg:pl-0 ${
        side === "left" ? "lg:col-start-1 lg:text-right" : "lg:col-start-3"
      }`}
    >
      <h3 className="text-lg font-semibold text-star-100">{item.title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-star-300">{item.body}</p>
      {children}
    </div>
  );
}

/** A stretch of rail between stations; captioned stretches say what travels on them. */
function Leg({ label }: { label?: string }) {
  return (
    <div className={`relative ${label ? "h-12" : "h-6"}`}>
      {label && (
        <span className="absolute top-1/2 left-10 -translate-y-1/2 font-mono text-[11px] leading-snug tracking-wider text-star-500 uppercase lg:left-1/2 lg:ml-5 lg:whitespace-nowrap">
          {label}
        </span>
      )}
    </div>
  );
}

/** The struck server rack — the one icon that survives, because the ghost station IS its meaning. */
function RackGhost() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden="true"
    >
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
      <path d="m3 21 18-18" />
    </svg>
  );
}

export function Features() {
  const { t } = useTranslation();
  const items = t("features.items", { returnObjects: true }) as Item[];

  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="max-w-[20ch] font-display text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
        {t("features.title")}
      </h2>
      <p className="mt-4 max-w-[62ch] text-lg leading-relaxed text-star-300">{t("features.sub")}</p>

      <div className="mt-12 rounded-2xl border border-field-500/60 bg-field-800/60 px-5 py-8 backdrop-blur-sm sm:px-8 sm:py-10">
        <p className="font-mono text-[11px] tracking-wider text-star-500 uppercase">
          {t("route.title")}
        </p>

        <div className="relative mt-6">
          {/* the rail every stop hangs on */}
          <span
            aria-hidden="true"
            className="absolute top-2 bottom-2 left-[13px] w-px bg-flare-500/25 lg:left-1/2"
          />

          {/* the port: a task arrives, from you or from an MCP client */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <Station>
              <span className="flex flex-wrap items-center gap-2 lg:justify-center">
                <Chip>{t("route.you")}</Chip>
                <span className="font-mono text-[10px] tracking-wider text-star-500 uppercase">
                  {t("route.or")}
                </span>
                <Chip>{t("route.mcp")}</Chip>
              </span>
            </Station>
            <Note item={items[4]} side="right" />
          </div>

          <Leg />

          {/* the hub: everything passes through the extension */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <Station>
              <Chip tone="hub">
                <CometMark size={14} />
                {t("route.extension")}
              </Chip>
            </Station>
          </div>

          {/* the ghost spur: the relay station this line does not serve */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <div className="relative flex items-center gap-3 py-1 pl-10 lg:hidden">
              <span
                aria-hidden="true"
                className="absolute top-1/2 left-[7px] size-3 -translate-y-1/2 rounded-full border-2 border-dashed border-star-500/60 bg-field-900"
              />
              <Chip tone="ghost">
                <RackGhost />
                <span className="line-through decoration-star-500/60">{t("route.relay")}</span>
              </Chip>
            </div>
            <Note item={items[5]} side="left" />
            {/* the spur's anchor: the same dashed dot the mobile rail shows */}
            <div
              aria-hidden="true"
              className="hidden lg:col-start-2 lg:row-start-1 lg:flex lg:justify-center"
            >
              <span className="size-3 rounded-full border-2 border-dashed border-star-500/60 bg-field-900" />
            </div>
            <div
              aria-hidden="true"
              className="hidden lg:col-start-3 lg:row-start-1 lg:-ml-8 lg:flex lg:items-center"
            >
              <span className="w-14 border-t border-dashed border-star-500/50" />
              <Chip tone="ghost">
                <RackGhost />
                <span className="line-through decoration-star-500/60">{t("route.relay")}</span>
              </Chip>
            </div>
          </div>

          <Leg label={t("route.legAsk")} />

          {/* the provider hop: direct, key attached */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <Station>
              <Chip>{t("route.provider")}</Chip>
            </Station>
            <Note item={items[0]} side="right">
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((preset) => (
                  <li
                    key={preset}
                    className="rounded-md border border-field-500/60 px-2 py-0.5 font-mono text-[11px] text-star-300"
                  >
                    {preset}
                  </li>
                ))}
                <li className="rounded-md border border-flare-500/40 px-2 py-0.5 font-mono text-[11px] text-flare-300">
                  {t("features.providersMore")}
                </li>
              </ul>
            </Note>
          </div>

          <Leg />

          {/* the gate: consequential actions stop here until you say so */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <Station>
              <Chip tone="gate">{t("route.gate")}</Chip>
            </Station>
            <Note item={items[3]} side="left" />
          </div>

          <Leg label={t("route.legAct")} />

          {/* the page: trusted input in, the accessibility tree out */}
          <div className="relative lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-x-8">
            <Station>
              <Chip>{t("route.page")}</Chip>
            </Station>
            <Note item={items[1]} side="right" />
            <Note item={items[2]} side="left">
              <pre className="mt-3 overflow-x-auto rounded-lg border border-field-500/60 bg-field-900/70 px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-star-300">
                <code>
                  <span className="text-flare-300">[ref=e12]</span> button &quot;Submit&quot;
                  {"\n"}
                  <span className="text-flare-300">[ref=e13]</span> textbox &quot;Email&quot;
                </code>
              </pre>
            </Note>
          </div>
        </div>
      </div>
    </section>
  );
}
