// Contract tests for the batch preference resolver + coercion + kind/status
// helpers (lib/batch/types.ts). Pure — no DB, no network. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BATCH_SAVINGS,
  coerceBatchSavings,
  effectiveChoice,
  isBatchEnabled,
  isCancelable,
  isPollable,
  isTerminal,
  legOfKind,
  providerOfKind,
  type BatchSavings,
} from "./types";

test("legOfKind / providerOfKind: only ingest_embedding is the embedding/voyage leg", () => {
  assert.equal(legOfKind("ingest_embedding"), "embedding");
  assert.equal(providerOfKind("ingest_embedding"), "voyage");
  for (const k of ["question_generation", "ndcg_ranking", "cluster_labeling"] as const) {
    assert.equal(legOfKind(k), "llm");
    assert.equal(providerOfKind(k), "anthropic");
  }
});

test("effectiveChoice: BULK mode reads the leg and ignores per-job values", () => {
  const s: BatchSavings = {
    mode: "bulk",
    bulk: { embedding: "standard", llm: "batch" },
    // Per-job values are the OPPOSITE, to prove bulk mode ignores them.
    jobs: {
      question_generation: "standard",
      ndcg_ranking: "standard",
      cluster_labeling: "standard",
      ingest_embedding: "batch",
    },
  };
  assert.equal(effectiveChoice(s, "question_generation"), "batch"); // llm leg
  assert.equal(effectiveChoice(s, "cluster_labeling"), "batch"); // llm leg
  assert.equal(effectiveChoice(s, "ingest_embedding"), "standard"); // embedding leg
  assert.equal(isBatchEnabled(s, "ndcg_ranking"), true);
  assert.equal(isBatchEnabled(s, "ingest_embedding"), false);
});

test("effectiveChoice: INDIVIDUAL mode reads per-job and ignores the bulk legs", () => {
  const s: BatchSavings = {
    mode: "individual",
    bulk: { embedding: "batch", llm: "batch" }, // opposite of the per-job values
    jobs: {
      question_generation: "batch",
      ndcg_ranking: "standard",
      cluster_labeling: "batch",
      ingest_embedding: "standard",
    },
  };
  assert.equal(effectiveChoice(s, "question_generation"), "batch");
  assert.equal(effectiveChoice(s, "ndcg_ranking"), "standard");
  assert.equal(effectiveChoice(s, "cluster_labeling"), "batch");
  assert.equal(effectiveChoice(s, "ingest_embedding"), "standard"); // NOT the bulk 'batch'
});

test("coerceBatchSavings: tolerant of junk, missing, and partial input", () => {
  assert.deepEqual(coerceBatchSavings(undefined), DEFAULT_BATCH_SAVINGS);
  assert.deepEqual(coerceBatchSavings({}), DEFAULT_BATCH_SAVINGS);
  // Unknown mode falls back to bulk; bad choices fall back to the default.
  const c = coerceBatchSavings({
    mode: "sideways",
    bulk: { llm: "batch", embedding: "nonsense" },
    jobs: { question_generation: "batch" },
  });
  assert.equal(c.mode, "bulk");
  assert.equal(c.bulk.llm, "batch");
  assert.equal(c.bulk.embedding, "standard"); // 'nonsense' rejected
  assert.equal(c.jobs.question_generation, "batch");
  assert.equal(c.jobs.ndcg_ranking, "standard"); // filled from default
});

test("coerceBatchSavings preserves BOTH mode maps so flipping the dropdown loses nothing", () => {
  const s = coerceBatchSavings({
    mode: "individual",
    bulk: { embedding: "batch", llm: "standard" },
    jobs: { cluster_labeling: "batch" },
  });
  // Both the bulk legs and the per-job map survive the round-trip.
  assert.equal(s.bulk.embedding, "batch");
  assert.equal(s.jobs.cluster_labeling, "batch");
});

test("status predicates", () => {
  assert.equal(isTerminal("applied"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("canceled"), true);
  assert.equal(isTerminal("expired"), true);
  assert.equal(isTerminal("in_progress"), false);
  assert.equal(isTerminal("completed"), false); // completed = not yet applied

  assert.equal(isCancelable("in_progress"), true);
  assert.equal(isCancelable("submitting"), true);
  assert.equal(isCancelable("completed"), false);

  assert.equal(isPollable("in_progress"), true);
  assert.equal(isPollable("completed"), true);
  assert.equal(isPollable("submitting"), false);
});
