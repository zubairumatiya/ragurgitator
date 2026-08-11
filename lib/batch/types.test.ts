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
  type BatchSavings,
} from "./types";

// The leg is still a per-kind fact (it groups the Settings dropdown); the
// PROVIDER is not, and deliberately has no per-kind function to test — it is
// derived from each job's model by build(), see BuiltBatch.provider.
test("legOfKind: only ingest_embedding is the embedding leg", () => {
  assert.equal(legOfKind("ingest_embedding"), "embedding");
  for (const k of [
    "question_generation",
    "ndcg_ranking",
    "cluster_labeling",
    "cache_pair_generation",
  ] as const) {
    assert.equal(legOfKind(k), "llm");
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
    semanticCache: { serve: false, threshold: null, keyModel: null, acceptTarget: null },
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

test("coerceBatchSavings: acceptTarget override only survives inside [0.5, 1]", () => {
  const at = (raw: unknown) => coerceBatchSavings({ semanticCache: { acceptTarget: raw } })
    .semanticCache.acceptTarget;

  assert.equal(at(0.95), 0.95);
  assert.equal(at(0.9), 0.9);
  // Both endpoints are real settings. 1 is not "unset" — it demands a perfectly
  // clean served prefix, which is what a small judged set enforces anyway.
  assert.equal(at(0.5), 0.5);
  assert.equal(at(1), 1);

  // Absent (every row written before this field existed) and explicit null mean
  // INHERIT the global 0.99.
  assert.equal(
    coerceBatchSavings({ semanticCache: { serve: true } }).semanticCache.acceptTarget,
    null,
  );
  assert.equal(at(null), null);
  assert.equal(at("0.95"), null);
  assert.equal(at(Number.NaN), null);

  // Out of band means INHERIT, not clamp. Below 0.5 the sweep would be told a
  // majority-wrong served set is acceptable — no caller means that, so the
  // global target takes over rather than the number reaching the sweep.
  assert.equal(at(0.4), null);
  assert.equal(at(0), null);
  assert.equal(at(1.5), null);
  assert.equal(at(-1), null);
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
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("expired"), true);
  assert.equal(isTerminal("in_progress"), false);
  assert.equal(isTerminal("completed"), false); // completed = not yet applied

  assert.equal(isCancelable("in_progress"), true);
  // Not submitting: there is no provider_batch_id yet to cancel, so a Cancel
  // button here is a click that does nothing. cancelJob refuses it too, and the
  // two must agree — that disagreement is what put a dead button on the panel.
  assert.equal(isCancelable("submitting"), false);
  assert.equal(isCancelable("completed"), false);
  assert.equal(isCancelable("cancelling"), false); // already winding down

  assert.equal(isPollable("in_progress"), true);
  assert.equal(isPollable("completed"), true);
  assert.equal(isPollable("submitting"), false);
});
