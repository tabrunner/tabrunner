import { describe, expect, it } from "vitest";
import { engineLabel } from "../ui/engine-label";

// The trigger chip's contract: auto names its resolution, a pinned model stands
// alone, effort rides only when the user set one — and the two halves stay
// separate so the composer can truncate one without losing the other.
describe("engineLabel", () => {
  it("names auto's resolution so it never reads as pinned", () => {
    expect(engineLabel({ auto: true, modelName: "Claude Sonnet 4.5", autoText: "Auto" }).full).toBe(
      "Auto · Claude Sonnet 4.5",
    );
  });

  it("degrades to bare Auto when nothing resolves yet", () => {
    expect(engineLabel({ auto: true, autoText: "Auto" }).full).toBe("Auto");
  });

  it("shows the pinned model without the auto qualifier", () => {
    expect(engineLabel({ auto: false, modelName: "gpt-5.4", autoText: "Auto" }).full).toBe(
      "gpt-5.4",
    );
  });

  it("appends effort only when set", () => {
    expect(
      engineLabel({ auto: false, modelName: "gpt-5.4", autoText: "Auto", effortLabel: "High" })
        .full,
    ).toBe("gpt-5.4 · High");
    expect(engineLabel({ auto: true, modelName: "X", autoText: "Auto" }).effort).toBeUndefined();
  });

  it("keeps effort out of the truncating half", () => {
    // The composer truncates `model` and pins `effort`. Folding the effort into
    // `model` would put it back on the chopping block at narrow widths.
    const label = engineLabel({
      auto: false,
      modelName: "claude-3-5-sonnet-20241022",
      autoText: "Auto",
      effortLabel: "High",
    });
    expect(label.model).toBe("claude-3-5-sonnet-20241022");
    expect(label.effort).toBe("High");
  });
});
