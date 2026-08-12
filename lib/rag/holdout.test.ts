// Contract tests for the holdout draw (lib/rag/holdout.ts). These are the
// properties the generalization number depends on: the same seed reproduces the
// same split, the split is not easier than the train set, and a later batch of
// questions cannot move an existing holdout member back into training.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type HoldoutCandidate,
  type HoldoutSettings,
  holdoutTarget,
  selectHoldout,
} from "./holdout";

const SETTINGS: HoldoutSettings = { enabled: true, mode: "pct", size: 25, seed: 7 };

// n candidates per difficulty band, ids stable across calls.
function pool(counts: Record<string, number>): HoldoutCandidate[] {
  const out: HoldoutCandidate[] = [];
  for (const [difficulty, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      out.push({ questionId: `${difficulty}-${String(i).padStart(3, "0")}`, difficulty });
    }
  }
  return out;
}

const band = (ids: string[], name: string) => ids.filter((id) => id.startsWith(name)).length;

test("percent rounds to nearest and clamps to the pool", () => {
  assert.equal(holdoutTarget(390, SETTINGS), 98);
  assert.equal(holdoutTarget(0, SETTINGS), 0);
  assert.equal(holdoutTarget(10, { ...SETTINGS, mode: "count", size: 40 }), 10);
  assert.equal(holdoutTarget(10, { ...SETTINGS, mode: "count", size: 4 }), 4);
});

test("a disabled holdout draws nothing, whatever the size says", () => {
  assert.equal(holdoutTarget(390, { ...SETTINGS, enabled: false }), 0);
  assert.deepEqual(selectHoldout(pool({ easy: 10 }), 0, 7), []);
});

test("the same seed reproduces the split; a different seed does not", () => {
  const candidates = pool({ easy: 60, medium: 60 });
  const a = selectHoldout(candidates, 30, 7);
  const b = selectHoldout(candidates, 30, 7);
  const c = selectHoldout(candidates, 30, 8);
  assert.deepEqual(a.sort(), b.sort());
  assert.notDeepEqual(a.sort(), c.sort());
});

test("row order does not change the split — only the seed does", () => {
  const candidates = pool({ easy: 40, medium: 40 });
  const reversed = [...candidates].reverse();
  assert.deepEqual(
    selectHoldout(candidates, 20, 7).sort(),
    selectHoldout(reversed, 20, 7).sort(),
  );
});

test("the draw is stratified: each band gives up its own share", () => {
  // A flat random 25% could take almost all of one band; the quota cannot.
  const picked = selectHoldout(pool({ easy: 200, medium: 160, hard: 40 }), 100, 3);
  assert.equal(picked.length, 100);
  assert.equal(band(picked, "easy"), 50);
  assert.equal(band(picked, "medium"), 40);
  assert.equal(band(picked, "hard"), 10);
});

test("a full band spills its overflow onto the others, so the target is still met", () => {
  // 10 of 11, with a one-question `hard` band that fills immediately.
  const picked = selectHoldout(pool({ easy: 5, medium: 5, hard: 1 }), 10, 5);
  assert.equal(picked.length, 10);
  assert.equal(band(picked, "hard"), 1); // capped by the band's own size
  assert.equal(band(picked, "easy") + band(picked, "medium"), 9);
});

test("questions with no difficulty form their own band rather than being dropped", () => {
  const candidates: HoldoutCandidate[] = [
    ...pool({ easy: 8 }),
    { questionId: "none-0", difficulty: null },
    { questionId: "none-1", difficulty: null },
  ];
  const picked = selectHoldout(candidates, 5, 11);
  assert.equal(picked.length, 5);
  assert.equal(picked.filter((id) => id.startsWith("none")).length, 1);
});

test("topping up keeps every existing member — a train question cannot leak in later", () => {
  const first = pool({ easy: 40, medium: 40 });
  const before = selectHoldout(first, 20, 7);
  // Phase 5 writes another batch, then the split is redrawn at the same size.
  const grown = [
    ...first,
    ...pool({ easy: 40, medium: 40 }).map((c) => ({
      ...c,
      questionId: `${c.questionId}-b2`,
    })),
  ];
  const after = selectHoldout(grown, 40, 7, new Set(before));
  for (const id of before) assert.ok(after.includes(id), `${id} left the holdout`);
  assert.equal(after.length, 40);
});

test("shrinking the holdout drops members but keeps the rest stable", () => {
  const candidates = pool({ easy: 40, medium: 40 });
  const before = selectHoldout(candidates, 40, 7);
  const after = selectHoldout(candidates, 20, 7, new Set(before));
  assert.equal(after.length, 20);
  for (const id of after) assert.ok(before.includes(id));
});

test("a target beyond the pool takes everything and stops", () => {
  const candidates = pool({ easy: 3, medium: 2 });
  assert.equal(selectHoldout(candidates, 999, 7).length, 5);
});
