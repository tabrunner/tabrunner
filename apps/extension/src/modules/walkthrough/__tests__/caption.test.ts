import { describe, it, expect } from "vitest";
import { buildSteps, DOCUMENTED_TOOLS } from "../caption";
import type { Frame } from "../types";

// i18n (the en catalog) comes from src/test-setup.ts.

let seq = 0;
function frame(
  tool: string,
  args: Record<string, unknown> = {},
  extra: Partial<Frame> = {},
): Frame {
  return {
    recordingId: "r1",
    seq: seq++,
    tool,
    args,
    url: "https://mail.example.com/inbox",
    title: "Inbox",
    ts: 0,
    ok: true,
    ...extra,
  };
}

function captions(frames: Frame[]): string[] {
  return buildSteps(frames).map((s) => s.caption);
}

describe("buildSteps", () => {
  it("writes imperative captions from the model's intent", () => {
    seq = 0;
    expect(
      captions([
        frame("navigate", { url: "https://mail.example.com/inbox", intent: "the inbox" }),
        frame("click", { ref: "e42", intent: "Compose" }),
        frame("press_key", { key: "Enter", modifiers: ["Mod"] }),
      ]),
    ).toEqual(["Go to mail.example.com", "Click Compose", "Press Ctrl/Cmd+Enter"]);
  });

  it("writes chords the way a person types them, not the way the protocol names them", () => {
    seq = 0;
    // "Mod" and "Meta" are the model's vocabulary (SUPPORTED_MODIFIERS). A doc
    // that says "Press Meta+Enter" is back to being a mouse log.
    expect(
      captions([
        frame("press_key", { key: "k", modifiers: ["Meta"] }),
        frame("press_key", { key: "z", modifiers: ["Control", "Shift"] }),
      ]),
    ).toEqual(["Press Cmd+k", "Press Ctrl+Shift+z"]);
  });

  it("numbers steps densely from 1, whatever the frame seq", () => {
    seq = 7;
    const steps = buildSteps([frame("click", { intent: "Send" }), frame("go_back")]);
    expect(steps.map((s) => s.number)).toEqual([1, 2]);
  });

  it("carries the typed value as a copyable value, not inside the caption", () => {
    seq = 0;
    const [step] = buildSteps([
      frame("fill", { ref: "e9", intent: "Subject", text: "Q3 numbers" }),
    ]);
    expect(step?.caption).toBe("Enter this in Subject");
    expect(step?.value).toBe("Q3 numbers");
  });

  it("masks a value whose field looks credential-shaped", () => {
    seq = 0;
    const [step] = buildSteps([
      frame("fill", { ref: "e2", intent: "the password field", text: "hunter2" }),
    ]);
    expect(step?.value).toBeUndefined();
    expect(step?.caption).not.toContain("hunter2");
    // The field label the model writes is a noun phrase with its own article
    // ("the password field"), so the template has to read around it.
    expect(step?.caption).toBe("Enter your own value in the password field");
  });

  it("drops failed attempts, which is what collapses a retried click into one step", () => {
    seq = 0;
    expect(
      captions([
        frame("click", { intent: "Export" }, { ok: false }),
        frame("click", { intent: "Export" }),
      ]),
    ).toEqual(["Click Export"]);
  });

  it("keeps a gap as a visible placeholder rather than skipping the step", () => {
    seq = 0;
    const steps = buildSteps([frame("click", { intent: "Save" }, { gap: "timeout", ok: true })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.caption).toBe("This screen didn't get captured");
  });

  it("keeps the bookend frames, which never had an action to succeed at", () => {
    seq = 0;
    expect(captions([frame("", {}, { ok: undefined }), frame("", {}, { ok: undefined })])).toEqual([
      "Starting point",
      "Result",
    ]);
  });

  it("documents the tools a reader performs and no agent machinery", () => {
    for (const tool of ["click", "fill", "type", "navigate", "press_key", "evaluate"]) {
      expect(DOCUMENTED_TOOLS.has(tool)).toBe(true);
    }
    for (const tool of [
      "snapshot",
      "find",
      "screenshot",
      "read_page_text",
      "scroll_down",
      "plan",
    ]) {
      expect(DOCUMENTED_TOOLS.has(tool)).toBe(false);
    }
  });
});
