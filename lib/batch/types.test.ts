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
  for (const k of [
    "question_generation",
    "ndcg_ranking",
    "cluster_labeling",
    "cache_pair_generation",
  ] as const) {
    assert.equal(legOfKind(k), "llm");
    assert.equal(providerOfKind(k), "anthropic");
  }
});

test("effectiveChoice: each job stands alone — one choice never moves another", () => {
  const s: BatchSavings = {
    jobs: {
      question_generation: "batch",
      ndcg_ranking: "standard",
      cluster_labeling: "batch",
      ingest_embedding: "standard",
      cache_pair_generation: "standard",
    },
    semanticCache: { serve: false, threshold: null, keyModel: null },
  };
  assert.equal(effectiveChoice(s, "question_generation"), "batch");
  assert.equal(effectiveChoice(s, "ndcg_ranking"), "standard");
  // Same provider/leg as question_generation, and still independent of it.
  assert.equal(effectiveChoice(s, "cluster_labeling"), "batch");
  assert.equal(effectiveChoice(s, "ingest_embedding"), "standard");
  assert.equal(isBatchEnabled(s, "question_generation"), true);
  assert.equal(isBatchEnabled(s, "ingest_embedding"), false);
});

test("coerceBatchSavings: tolerant of junk, missing, and partial input", () => {
  assert.deepEqual(coerceBatchSavings(undefined), DEFAULT_BATCH_SAVINGS);
  assert.deepEqual(coerceBatchSavings({}), DEFAULT_BATCH_SAVINGS);
  // A bad choice falls back to the default ('standard'), never to an invented
  // value and never to 'batch' — a surprise batch would stall an inline flow.
  const c = coerceBatchSavings({
    jobs: { question_generation: "batch", cluster_labeling: "nonsense" },
  });
  assert.equal(c.jobs.question_generation, "batch");
  assert.equal(c.jobs.cluster_labeling, "standard"); // 'nonsense' rejected
  assert.equal(c.jobs.ndcg_ranking, "standard"); // absent → default
  assert.equal(c.semanticCache.serve, false); // absent → serving off

  // serve is a STRICT boolean: only literal true enables it, everything else
  // (missing, "yes", 1, null) coerces to off — a wrong served answer is worse
  // than a missed cache, so the default must never be surprised on.
  assert.equal(coerceBatchSavings({ semanticCache: { serve: true } }).semanticCache.serve, true);
  assert.equal(coerceBatchSavings({ semanticCache: { serve: "yes" } }).semanticCache.serve, false);
  assert.equal(coerceBatchSavings({ semanticCache: {} }).semanticCache.serve, false);
});

test("coerceBatchSavings: threshold override only survives as a real cosine", () => {
  const th = (raw: unknown) => coerceBatchSavings({ semanticCache: { threshold: raw } })
    .semanticCache.threshold;

  assert.equal(th(0.94), 0.94);
  // The endpoints are legal values, and 0 must not be mistaken for "unset" —
  // it's a real (if reckless) setting meaning "serve any nearest match".
  assert.equal(th(0), 0);
  assert.equal(th(1), 1);

  // Everything unusable means INHERIT, never a number the serving gate could
  // act on: absent (every row written before this field existed), explicit null,
  // strings from a hand-edited blob, NaN, and out-of-range cosines.
  assert.equal(coerceBatchSavings({ semanticCache: { serve: true } }).semanticCache.threshold, null);
  assert.equal(th(null), null);
  assert.equal(th("0.94"), null);
  assert.equal(th(Number.NaN), null);
  assert.equal(th(1.5), null);
  assert.equal(th(-0.1), null);
});

test("coerceBatchSavings: keyModel override only survives as a non-empty string", () => {
  const km = (raw: unknown) => coerceBatchSavings({ semanticCache: { keyModel: raw } })
    .semanticCache.keyModel;

  assert.equal(km("voyage-4-large"), "voyage-4-large");
  assert.equal(km("  voyage-4  "), "voyage-4"); // trimmed, so padding can't miss the registry

  // Everything else means INHERIT the global default: absent (every row written
  // before this field existed), explicit null, blank, and non-strings.
  assert.equal(
    coerceBatchSavings({ semanticCache: { serve: true } }).semanticCache.keyModel,
    null,
  );
  assert.equal(km(null), null);
  assert.equal(km(""), null);
  assert.equal(km("   "), null);
  assert.equal(km(42), null);

  // An UNKNOWN id is deliberately kept here rather than nulled: this module has
  // no registry to check against (it's import-free by design), so validation is
  // the write path's job and the read path's fallback is resolveKeyModel's.
  assert.equal(km("not-a-real-model"), "not-a-real-model");
});

// --- migration off the two leg-grouped shapes ------------------------------
// Old rows keep their jsonb until something saves over them, so every one of
// these has to land on the same EFFECTIVE choice the config was running with.
//
// A job kind added AFTER a legacy blob was written (cache_pair_generation) has
// no entry in either map, so it resolves through its leg like any other — a row
// that said "all LLM jobs → batch" gets batch for it too. That's the intent the
// leg expressed, and the stake is async-vs-inline, never a wrong answer.

test("coerceBatchSavings migrates legacy mode:'bulk' — the leg wins, dead jobs map ignored", () => {
  const s = coerceBatchSavings({
    mode: "bulk",
    bulk: { embedding: "standard", llm: "batch" },
    // Under mode:'bulk' these were never in force. Merging them would silently
    // flip three jobs off batch, so they must be ignored outright.
    jobs: {
      question_generation: "standard",
      ndcg_ranking: "standard",
      cluster_labeling: "standard",
      ingest_embedding: "batch",
    },
  });
  assert.deepEqual(s.jobs, {
    question_generation: "batch", // from the llm leg, as before
    ndcg_ranking: "batch",
    cluster_labeling: "batch",
    ingest_embedding: "standard", // from the embedding leg, as before
    cache_pair_generation: "batch", // added later; resolves through the llm leg
  });
});

test("coerceBatchSavings migrates legacy mode:'individual' — the jobs map wins", () => {
  const s = coerceBatchSavings({
    mode: "individual",
    bulk: { embedding: "batch", llm: "batch" }, // dead under this mode
    jobs: {
      question_generation: "batch",
      ndcg_ranking: "standard",
      cluster_labeling: "batch",
      ingest_embedding: "standard",
    },
  });
  assert.deepEqual(s.jobs, {
    question_generation: "batch",
    ndcg_ranking: "standard",
    cluster_labeling: "batch",
    ingest_embedding: "standard", // NOT the stale 'batch' leg
    cache_pair_generation: "batch", // no entry in either map → the llm leg
  });
});

test("coerceBatchSavings migrates the legs+overrides shape — override, else leg", () => {
  // No `mode`; nullable `jobs` layered over `bulk`.
  const s = coerceBatchSavings({
    bulk: { embedding: "batch", llm: "standard" },
    jobs: {
      question_generation: "batch", // an override
      ndcg_ranking: null, // inherit
      cluster_labeling: null, // inherit
      ingest_embedding: null, // inherit
    },
  });
  assert.deepEqual(s.jobs, {
    question_generation: "batch", // the override
    ndcg_ranking: "standard", // the llm leg
    cluster_labeling: "standard",
    ingest_embedding: "batch", // the embedding leg
    cache_pair_generation: "standard", // the llm leg
  });
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
