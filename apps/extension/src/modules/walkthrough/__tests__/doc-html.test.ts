import { describe, it, expect } from "vitest";
import { buildDocHtml, docFilename } from "../doc-html";
import { buildSteps } from "../caption";
import type { Frame, Recording } from "../types";

// i18n (the en catalog) comes from src/test-setup.ts.

function recording(extra: Partial<Recording> = {}): Recording {
  return {
    id: "r1",
    conversationId: "c1",
    title: "Export the Q3 report",
    status: "complete",
    startedAt: Date.UTC(2026, 7, 19, 12, 0, 0),
    endedAt: Date.UTC(2026, 7, 19, 12, 2, 0),
    frames: 2,
    bytes: 1000,
    sites: ["reports.example.com"],
    armedAtStep: 0,
    outcome: "done",
    ...extra,
  };
}

function frame(
  seq: number,
  tool: string,
  args: Record<string, unknown>,
  extra: Partial<Frame> = {},
): Frame {
  return {
    recordingId: "r1",
    seq,
    tool,
    args,
    url: "https://reports.example.com/q3",
    title: "Q3",
    ts: 0,
    ok: true,
    ...extra,
  };
}

const IMG = "data:image/jpeg;base64,AAAA";

function build(rec: Recording, frames: Frame[], branding = true): string {
  const steps = buildSteps(frames);
  const images = new Map(frames.filter((f) => !f.gap).map((f) => [f.seq, IMG]));
  return buildDocHtml({ recording: rec, steps, images, branding });
}

describe("buildDocHtml", () => {
  it("renders a self-contained document with no external references", () => {
    const html = build(recording(), [frame(0, "click", { intent: "Export" })]);
    expect(html).toContain("<title>Export the Q3 report</title>");
    expect(html).toContain("Click Export");
    expect(html).toContain(IMG);
    // The only permitted outbound link is the credit — nothing is fetched.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toContain("<script");
  });

  it("names every site once, inside the sentence that says why it matters", () => {
    const html = build(recording({ sites: ["reports.example.com", "drive.example.com"] }), [
      frame(0, "click", { intent: "Export" }),
    ]);
    expect(html).toContain("sign in to reports.example.com, drive.example.com");
    // Once, not twice: a row of host chips above the sentence said the same
    // words with none of the reason.
    expect(html.match(/reports\.example\.com/g)).toHaveLength(1);
  });

  it("declares the document's language so it can be read aloud and translated", () => {
    const html = build(recording(), [frame(0, "click", { intent: "Export" })]);
    expect(html).toMatch(/^<!doctype html>\n<html lang="[a-zA-Z-]+">/);
  });

  it("keeps the marks that ARE their color when the doc is printed to PDF", () => {
    // Chrome drops backgrounds in print unless told otherwise, which would
    // print the step numbers white-on-white and erase the click marker — and
    // print IS the PDF export.
    const html = build(recording(), [frame(0, "click", { intent: "Export" })]);
    const print = html.slice(html.indexOf("@media print"));
    expect(print).toContain("print-color-adjust: exact");
    expect(print).toMatch(/\.num, \.mark, \.note/);
    // …and it must not carry a dark OS theme onto paper.
    expect(print).toContain("--bg: #fff");
  });

  it("describes which screen a shot shows rather than repeating the caption", () => {
    const html = build(recording(), [frame(0, "click", { intent: "Export" })]);
    expect(html).toContain('alt="Screen: Q3"');
    expect(html.match(/Click Export/g)).toHaveLength(1);
  });

  it("discloses a partial recording instead of presenting it as whole", () => {
    const html = build(recording({ status: "partial", outcome: "stopped" }), [
      frame(0, "click", { intent: "Export" }),
    ]);
    expect(html).toContain("interrupted");
    expect(html).toContain("stopped by hand");
  });

  it("says how many actions it missed when it started documenting late", () => {
    const html = build(recording({ armedAtStep: 3 }), [frame(0, "click", { intent: "Export" })]);
    expect(html).toContain("first 3 actions");
  });

  it("places the click marker as a fraction of the captured viewport", () => {
    const html = build(recording(), [
      frame(
        0,
        "click",
        { intent: "Export" },
        { click: { x: 320, y: 180 }, viewport: { width: 1280, height: 720 } },
      ),
    ]);
    expect(html).toContain('class="mark" style="left:25.000%;top:25.000%"');
  });

  it("leaves the marker out when the frame never learned a viewport", () => {
    const html = build(recording(), [
      frame(0, "click", { intent: "Export" }, { click: { x: 10, y: 10 } }),
    ]);
    expect(html).not.toContain('class="mark"');
  });

  it("renders a gap frame as a named placeholder, never a missing step", () => {
    const html = build(recording(), [frame(0, "click", { intent: "Save" }, { gap: "timeout" })]);
    expect(html).toContain("didn't get captured");
  });

  it("drops the whole footer when the user unticks the credit", () => {
    const withCredit = build(recording(), [frame(0, "go_back", {})], true);
    const without = build(recording(), [frame(0, "go_back", {})], false);
    expect(withCredit).toContain("tabrunner.app");
    expect(without).not.toContain("tabrunner.app");
    // An empty bordered footer would read as a paragraph that went missing.
    expect(without).not.toContain("<footer");
  });

  it("escapes page-supplied text so a hostile title cannot inject markup", () => {
    const html = build(recording({ title: '<img src=x onerror="alert(1)">' }), [
      frame(0, "fill", { intent: "Name", text: "</code><script>bad()</script>" }),
    ]);
    expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("&lt;script&gt;bad()");
  });
});

describe("docFilename", () => {
  it("names the file after the process, stripped of path-hostile characters", () => {
    expect(docFilename(recording({ title: "Export: Q3/Q4 report?" }))).toBe(
      "Export Q3Q4 report.html",
    );
  });

  it("falls back to a real name when the title is all punctuation", () => {
    expect(docFilename(recording({ title: "///" }))).toBe("walkthrough.html");
  });
});
