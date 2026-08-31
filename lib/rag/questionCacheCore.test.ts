import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuestion, selectNewQuestions } from "./questionCacheCore";

// "Add cached" tops a chunk up from the bank with no target and no difficulty to
// limit it, so the dedupe is the ONLY thing standing between a chunk and a
// duplicate of a question it already shows. These cases are that guard.
const q = (question: string, difficulty = "easy") => ({ question, difficulty });

test("selectNewQuestions: a chunk with no questions takes the whole bank", () => {
  const banked = [q("What is A?"), q("Why B?", "hard")];
  assert.deepEqual(selectNewQuestions(banked, []), banked);
});

test("selectNewQuestions: a question already on the chunk is not added again", () => {
  const banked = [q("What is A?"), q("Why B?")];
  assert.deepEqual(selectNewQuestions(banked, ["What is A?"]), [q("Why B?")]);
  // Every difficulty is a candidate, so the match must be on TEXT — a banked
  // 'hard' copy of a question the chunk shows as 'easy' is still a duplicate.
  assert.deepEqual(selectNewQuestions([q("What is A?", "hard")], ["What is A?"]), []);
});

test("selectNewQuestions: matching is case- and whitespace-blind", () => {
  // The same question re-generated under another config can come back with
  // different capitalisation or line wrapping; it is not a new question.
  assert.deepEqual(selectNewQuestions([q("  what  IS   a? ")], ["What is a?"]), []);
  // But a genuinely different wording IS a new question and must survive.
  assert.deepEqual(selectNewQuestions([q("What is a?!")], ["What is a?"]), [q("What is a?!")]);
});

test("selectNewQuestions: the bank's own duplicates land once", () => {
  // Two configs generating the same passage independently can bank identical
  // text in different slots.
  assert.deepEqual(selectNewQuestions([q("Dup?"), q("Dup?", "hard"), q("New?")], []), [
    q("Dup?"),
    q("New?"),
  ]);
});

test("selectNewQuestions: an exhausted chunk takes nothing", () => {
  assert.deepEqual(selectNewQuestions([q("A?"), q("B?")], ["b?", "A?"]), []);
  assert.deepEqual(selectNewQuestions([], ["A?"]), []);
});

test("selectNewQuestions: a blank banked question is never inserted", () => {
  assert.deepEqual(selectNewQuestions([q("   "), q("A?")], []), [q("A?")]);
});

test("normalizeQuestion: collapses the differences that don't make a question new", () => {
  assert.equal(normalizeQuestion("  What\n  is   A? "), "what is a?");
});

// The per-chunk cap is what turns one bank into a walk: with the bank ordered
// easy → medium → hard, a cap of 1 hands out the next difficulty each press.
test("selectNewQuestions: perChunk caps how many a chunk takes", () => {
  const banked = [q("Easy?"), q("Medium?", "medium"), q("Hard?", "hard")];
  assert.deepEqual(selectNewQuestions(banked, [], { perChunk: 1 }), [q("Easy?")]);
  assert.deepEqual(selectNewQuestions(banked, [], { perChunk: 2 }), [
    q("Easy?"),
    q("Medium?", "medium"),
  ]);
  // A cap larger than the bank is not an error, and no cap at all is the old
  // behaviour — every caller that predates the option must be unaffected.
  assert.deepEqual(selectNewQuestions(banked, [], { perChunk: 9 }), banked);
  assert.deepEqual(selectNewQuestions(banked, []), banked);
});

test("selectNewQuestions: the cap applies AFTER the dedupe, so the walk advances", () => {
  // Press 2: the chunk already shows its easy question. Capping before the dedupe
  // would spend the cap on the row about to be discarded and land nothing, and
  // the visitor's second press would silently do nothing.
  const banked = [q("Easy?"), q("Medium?", "medium"), q("Hard?", "hard")];
  assert.deepEqual(selectNewQuestions(banked, ["Easy?"], { perChunk: 1 }), [
    q("Medium?", "medium"),
  ]);
  // Press 3 on a two-difficulty bank: exhausted, and it reports so rather than
  // repeating anything.
  assert.deepEqual(
    selectNewQuestions(banked.slice(0, 2), ["Easy?", "Medium?"], { perChunk: 1 }),
    [],
  );
});

test("selectNewQuestions: perChunk 0 adds nothing", () => {
  assert.deepEqual(selectNewQuestions([q("A?")], [], { perChunk: 0 }), []);
});
