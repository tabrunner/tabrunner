import { describe, expect, it } from "vitest";
import { MODEL_ROW_CAP, narrowModels } from "../ui/narrow-models";
import type { ModelInfo } from "../types";

// The engine picker has to survive an OpenRouter-sized listing (300+ models):
// filter on either the wire id or the display name, cap the rows, and always
// report what the cap held back.
const list = (n: number): ModelInfo[] =>
  Array.from({ length: n }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` }));

describe("narrowModels", () => {
  it("passes a short list through untouched", () => {
    const { shown, hidden, matched } = narrowModels(list(5), "");
    expect(shown).toHaveLength(5);
    expect(hidden).toBe(0);
    expect(matched).toBe(5);
  });

  it("caps a huge listing and counts the remainder", () => {
    const { shown, hidden, matched } = narrowModels(list(400), "");
    expect(shown).toHaveLength(MODEL_ROW_CAP);
    expect(matched).toBe(400);
    expect(hidden).toBe(400 - MODEL_ROW_CAP);
  });

  it("matches the wire id and the display name, case-blind", () => {
    const models: ModelInfo[] = [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "gpt-5.4" },
    ];
    expect(narrowModels(models, "sonnet-4-5").shown).toHaveLength(1);
    expect(narrowModels(models, "CLAUDE SONNET").shown).toHaveLength(1);
    expect(narrowModels(models, "gpt").shown[0]?.id).toBe("gpt-5.4");
  });

  it("matches words anywhere, in any order, across id and name", () => {
    const models: ModelInfo[] = [
      { id: "meta/muse-spark-1.2-contributor", name: "Meta: Muse Spark 1.2 Contributor" },
    ];
    // Words out of order, mid-name, and split across the id and the name.
    expect(narrowModels(models, "contributor muse").shown).toHaveLength(1);
    expect(narrowModels(models, "spark 1.2").shown).toHaveLength(1);
    expect(narrowModels(models, "meta muse").shown).toHaveLength(1);
    expect(narrowModels(models, "spark missing").shown).toHaveLength(0);
  });

  it("reports an empty match instead of silently showing everything", () => {
    const { shown, matched } = narrowModels(list(20), "nothing-like-this");
    expect(shown).toHaveLength(0);
    expect(matched).toBe(0);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(narrowModels(list(3), "  model-1  ").shown[0]?.id).toBe("model-1");
  });
});
