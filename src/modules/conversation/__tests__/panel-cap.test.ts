import { describe, it, expect } from "vitest";
import { capMessages } from "../ui/store";
import { RECENT_WINDOW } from "../conversations";
import type { Message } from "../types";

/**
 * The panel's in-memory transcript must stay bounded the way storage already
 * bounds its own. Before this, a long run grew the list without limit — every
 * step, every thought, every base64 screenshot — so the live panel was heavier
 * than the very same conversation reopened, which loads a pruned transcript and
 * no screenshots at all.
 */
function step(i: number, images?: string[]): Message {
  return {
    id: `s${i}`,
    role: "step",
    content: `shot ${i}`,
    tool: "screenshot",
    timestamp: i,
    ...(images ? { images } : {}),
  };
}

describe("capMessages", () => {
  it("keeps the newest window of step rows and drops the older ones", () => {
    const list = Array.from({ length: RECENT_WINDOW + 40 }, (_, i) => step(i));
    const capped = capMessages(list);

    // Steps are not spine: past the window they go, so the panel's copy stops
    // at the window even though the transcript's ceiling is far above it.
    expect(capped.length).toBe(RECENT_WINDOW);
    expect(capped[0]?.id).toBe("s40");
    expect(capped.at(-1)?.id).toBe(`s${RECENT_WINDOW + 39}`);
  });

  it("returns the same array when nothing needs dropping — no needless re-render", () => {
    const list = [step(0), step(1)];
    expect(capMessages(list)).toBe(list);
  });

  it("lets go of all but the newest screenshots", () => {
    const list = Array.from({ length: 20 }, (_, i) => step(i, [`data:image/png;base64,shot${i}`]));
    const withImages = capMessages(list).filter((m) => m.images?.length);

    expect(withImages.length).toBeGreaterThan(0);
    expect(withImages.length).toBeLessThanOrEqual(6);
    // The ones kept are the newest — an old thumbnail is the cheapest thing to
    // lose, and a reopened conversation shows none of them anyway.
    expect(withImages.at(-1)?.id).toBe("s19");
    expect(withImages[0]?.id).toBe("s14");
  });

  it("never drops a user's own attachment — it is what the task is about", () => {
    const mine: Message = {
      id: "u1",
      role: "user",
      content: "what is in this?",
      images: ["data:image/png;base64,mine"],
      timestamp: 0,
    };
    const list = [
      mine,
      ...Array.from({ length: 20 }, (_, i) => step(i, [`data:image/png;base64,shot${i}`])),
    ];

    const kept = capMessages(list).find((m) => m.id === "u1");
    expect(kept?.images).toEqual(["data:image/png;base64,mine"]);
  });
});
