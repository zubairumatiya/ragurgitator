// poolPairs — RAIL 2 of docs/probe-replay-plan.md: replaying our own generated
// pairs must add nothing to the key-model sweep and must never displace an
// audited label.
//
// This was true by accident of ordering before probe replay existed as a product
// feature; these tests make it true on purpose. The defect they encode is real
// and was measured (F3): letting a probe row win its collision meant the pair
// table's audited verdict was discarded in favour of the label the replay
// carried, the quarantine went inert for every probed pair, and the generated set
// the sweep scored collapsed from 165 pairs to 32.
//
// The probe-replay job makes that collision the NORMAL case rather than a
// research residue — it exists to push generated pair texts back through the
// lookup path — so the rule now guards a path every account will walk.
import assert from "node:assert/strict";
import test from "node:test";

import {
  pairKey,
  poolPairs,
  type GeneratedPair,
  type SweepPair,
} from "@/lib/rag/keyModelSweepCore";

const generated = (
  textA: string,
  textB: string,
  label: "same" | "different" = "different",
): GeneratedPair => ({ textA, textB, difficulty: "hard-negative", label });

const shadow = (
  textA: string,
  textB: string,
  origin: "traffic" | "probe",
  label: "same" | "different" = "same",
): SweepPair => ({ textA, textB, label, source: "shadow", origin, difficulty: null });

test("a probe row duplicating a generated pair is dropped", () => {
  // THE RAIL. The probe carries "same"; the generator's audited label is
  // "different". Letting the probe win is the F3 defect.
  const pooled = poolPairs(
    [generated("what was 2023 revenue", "what was 2024 revenue")],
    [],
    [shadow("what was 2023 revenue", "what was 2024 revenue", "probe")],
  );
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].source, "generated");
  assert.equal(pooled[0].label, "different");
});

test("orientation does not save a probe — the key is unordered", () => {
  // A shadow row's (new_query, matched_query) arrives in whichever order the
  // lookup happened to produce, and probe replay always probes the VARIANT, so
  // the reversed orientation is the one it actually writes.
  const pooled = poolPairs(
    [generated("a", "b")],
    [],
    [shadow("b", "a", "probe")],
  );
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].source, "generated");
});

test("a probe row duplicating a QUARANTINED pair is dropped too", () => {
  // The sharp edge. listPairs has already removed the quarantined pair, so
  // without the separate `quarantined` argument the probe meets no generated key,
  // survives, and re-enters the pool carrying the very label F3 disproved — the
  // quarantine removing nothing at all.
  const pooled = poolPairs(
    [],
    [{ textA: "a", textB: "b" }],
    [shadow("a", "b", "probe")],
  );
  assert.deepEqual(pooled, []);
});

test("a TRAFFIC shadow row still wins its collision", () => {
  // Not symmetric with the probe case, and deliberately so: traffic is a verdict
  // on a question a person actually asked, judged against a synthesized label.
  // Only probes are non-independent evidence.
  const pooled = poolPairs(
    [generated("a", "b")],
    [],
    [shadow("a", "b", "traffic")],
  );
  assert.equal(pooled.length, 1);
  assert.equal(pooled[0].source, "shadow");
  assert.equal(pooled[0].label, "same");
});

test("a probe row with NO generated counterpart is kept", () => {
  // The dedupe is scoped to collisions. A probe against a question the generator
  // never produced a pair for is ordinary evidence — dropping every probe would
  // discard the F1/F2 sample the sweep's hard-negative coverage rests on.
  const pooled = poolPairs([generated("a", "b")], [], [shadow("c", "d", "probe")]);
  assert.equal(pooled.length, 2);
  assert.equal(pooled.filter((p) => p.source === "shadow").length, 1);
});

test("self-pairs are dropped whatever their source", () => {
  // Cosine 1.0 against itself: it scores nothing and calibrates nothing. This is
  // also what a probe of the ORIGIN orientation would have produced, which is why
  // probe replay only ever probes the variant.
  const pooled = poolPairs([generated("a", "a", "same")], [], [shadow("b", "b", "traffic")]);
  assert.deepEqual(pooled, []);
});

test("pairKey: unordered, and its separator cannot occur in question text", () => {
  assert.equal(pairKey("a", "b"), pairKey("b", "a"));
  // A space or a punctuation separator could be forged by text that contains it:
  // ("a b", "c") and ("a", "b c") would collide. NUL cannot appear in a question.
  assert.notEqual(pairKey("a b", "c"), pairKey("a", "b c"));
});

test("later generated pairs do not multiply — the pool is keyed, not appended", () => {
  const pooled = poolPairs(
    [generated("a", "b"), generated("b", "a", "same")],
    [],
    [],
  );
  assert.equal(pooled.length, 1);
});
