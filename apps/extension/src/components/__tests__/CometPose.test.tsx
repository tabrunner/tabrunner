import { describe, expect, it } from "vitest";

// The poses are the brand mark in other postures, which only works while they
// are demonstrably the SAME object as the icon. Two guards matter here, and
// both are regressions that already happened once:
//
//  1. Geometry — every pose must draw the body from `COMET_GEOMETRY`, so an
//     edit to the mark moves the illustrations with it and a hand-typed path
//     fails here instead of quietly forking a third copy of the comet.
//  2. Framing — the drawing must fill its own viewBox. The first cut inherited
//     the icon's roomy 48×48 square, where the comet occupies only a band
//     across the middle, and every pose shipped as a ~13px sliver floating in a
//     third of its own box. Nothing caught it but a screenshot.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { CometPose, type Pose } from "../CometPose";
import { COMET_GEOMETRY, cometSvg } from "@/shared/logo";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const POSES: Pose[] = ["ready", "resting"];

/** The tab path's extremes, read off `COMET_GEOMETRY.tab`. */
const BODY = { minX: 23, maxX: 41, minY: 17, maxY: 30 };

async function render(pose: Pose) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(<CometPose pose={pose} size={48} />));
  return container;
}

function viewBoxOf(container: HTMLElement) {
  const [x, y, w, h] = (container.querySelector("svg")?.getAttribute("viewBox") ?? "")
    .split(/\s+/)
    .map(Number);
  return { x: x!, y: y!, w: w!, h: h! };
}

describe("comet poses", () => {
  it.each(POSES)("draws %s from the mark's own geometry", async (pose) => {
    const container = await render(pose);
    expect(container.querySelector(`path[d="${COMET_GEOMETRY.tab}"]`)).not.toBeNull();
  });

  it("keeps the icon builder reading the same ruler", () => {
    // cometSvg is what public/icon/* is rasterized from. If it ever stops
    // interpolating the shared constants, the poses and the installed icon can
    // drift apart without anything else noticing.
    const svg = cometSvg("full");
    expect(svg).toContain(COMET_GEOMETRY.tab);
    expect(svg).toContain(`cx="${COMET_GEOMETRY.dot.cx}"`);
    // Both trails run INTO the body, so both end at the same x.
    const { endX } = COMET_GEOMETRY.trail;
    expect(svg).toContain(`x="${endX - 12}"`);
    expect(svg).toContain(`x="${endX - 9}"`);
  });

  it("gives only `ready` a route", async () => {
    expect((await render("ready")).querySelector(".comet-runway")).not.toBeNull();
    expect((await render("resting")).querySelector(".comet-runway")).toBeNull();
  });

  it("frames `resting` on its content, not on the icon's empty square", async () => {
    const container = await render("resting");
    const box = viewBoxOf(container);
    const { endX, nearY, height } = COMET_GEOMETRY.trail;
    const trail = container.querySelector("rect")!;
    const trailX = Number(trail.getAttribute("x"));

    // Everything drawn sits inside the window…
    expect(trailX).toBeGreaterThanOrEqual(box.x);
    expect(BODY.maxX).toBeLessThanOrEqual(box.x + box.w);
    expect(BODY.minY).toBeGreaterThanOrEqual(box.y);
    expect(BODY.maxY).toBeLessThanOrEqual(box.y + box.h);

    // …and fills it. Slack on any edge beyond a couple of units means the
    // drawing is shrinking inside its own box again.
    expect(trailX - box.x).toBeLessThanOrEqual(2);
    expect(box.x + box.w - BODY.maxX).toBeLessThanOrEqual(2);
    expect(BODY.minY - box.y).toBeLessThanOrEqual(2);
    expect(box.y + box.h - BODY.maxY).toBeLessThanOrEqual(2);

    // The trail is a trail, not a stub beside the tab: at least 2.5x its height.
    expect(endX - trailX).toBeGreaterThanOrEqual(height * 2.5);
    expect(Number(trail.getAttribute("y"))).toBe(nearY);
  });

  it("places `ready`'s body clear of the route it has not run yet", async () => {
    // The body is drawn at 2x via one folded transform. It replaced a
    // three-step translate/scale/translate chain, and the two must map the
    // same — so assert the mapping by its result rather than its spelling.
    const container = await render("ready");
    const transform = container.querySelector("g[transform]")!.getAttribute("transform")!;
    const [, tx, ty] = transform.match(/translate\((-?\d+) (-?\d+)\)/)!.map(Number);
    const [, k] = transform.match(/scale\((\d+(?:\.\d+)?)\)/)!.map(Number);
    const at = (v: number, offset: number) => v * k! + offset;

    const box = viewBoxOf(container);
    expect(at(BODY.minX, tx!)).toBeGreaterThanOrEqual(box.x);
    expect(at(BODY.minY, ty!)).toBeGreaterThanOrEqual(box.y);
    expect(at(BODY.maxY, ty!)).toBeLessThanOrEqual(box.y + box.h);
    // The route starts at x=42; the body must not run into it.
    expect(at(BODY.maxX, tx!)).toBeLessThan(42);
    // And it must be big enough to read — two thirds of the canvas height.
    expect(at(BODY.maxY, ty!) - at(BODY.minY, ty!)).toBeGreaterThan(box.h * 0.6);
  });
});
