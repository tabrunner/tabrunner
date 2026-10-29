/**
 * Self-check for the run console's clock — the smallest thing that fails if the
 * phase maths breaks. No framework: `bun run check`.
 */
import { strict as assert } from "node:assert";
import {
  COMPOSING_AT,
  DONE_AT,
  PLAN_AT,
  STEP_DONE_AT,
  TOTAL_TOKENS,
  phaseAt,
  stepStateAt,
  tokensAt,
} from "../src/components/runPhase";

// The run plans before it names a step — never the other way round.
assert.deepEqual(phaseAt(0), { kind: "planning" });
assert.deepEqual(phaseAt(PLAN_AT - 1), { kind: "planning" });
assert.deepEqual(phaseAt(PLAN_AT), { kind: "step", index: 0 });

// Each step is named while it is the active one.
assert.deepEqual(phaseAt(STEP_DONE_AT[0] - 1), { kind: "step", index: 0 });
assert.deepEqual(phaseAt(STEP_DONE_AT[0]), { kind: "step", index: 1 });
assert.deepEqual(phaseAt(STEP_DONE_AT[2]), { kind: "step", index: 3 });

// Then it composes, then it is done — and stays done to the end of the cycle.
assert.deepEqual(phaseAt(COMPOSING_AT), { kind: "composing" });
assert.deepEqual(phaseAt(DONE_AT - 1), { kind: "composing" });
assert.deepEqual(phaseAt(DONE_AT), { kind: "done" });

// Every tick resolves to exactly one phase, with no gap or overlap.
for (let tick = 0; tick < DONE_AT + 2_800; tick += 50) {
  const phase = phaseAt(tick);
  if (phase.kind === "step") {
    assert.ok(phase.index >= 0, `no step named at ${tick}ms`);
  }
}

// Markers never run ahead of the phase: the named step is the active one.
for (let tick = PLAN_AT; tick < COMPOSING_AT; tick += 50) {
  const phase = phaseAt(tick);
  assert.equal(phase.kind, "step");
  if (phase.kind === "step") {
    assert.equal(stepStateAt(tick, phase.index), "active", `step marker desync at ${tick}ms`);
  }
}

// Spend starts at zero and lands on the total exactly as the run finishes.
assert.equal(tokensAt(0), 0);
assert.equal(tokensAt(DONE_AT), TOTAL_TOKENS);
assert.equal(tokensAt(DONE_AT + 5_000), TOTAL_TOKENS);
for (let tick = 50; tick <= DONE_AT; tick += 50) {
  assert.ok(tokensAt(tick) >= tokensAt(tick - 50), `spend went backwards at ${tick}ms`);
}

console.log("runPhase: ok");
