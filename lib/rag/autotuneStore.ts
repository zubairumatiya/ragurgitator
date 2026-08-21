// DB layer for autotune run history (migration 0016, Phase C of
// docs/eval-autotuning-plan.md) plus the config-scoped question ignores the
// engine must exclude from targeting (0014's config_question_ignores — written
// by the Phase D "ignore in rates" UI, but respected here from day one) and the
// holdout draw that reuses that same table (0061).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config.
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { Split } from "@/lib/rag/evalRates";
import {
  type HoldoutCandidate,
  type HoldoutMode,
  type HoldoutSettings,
  holdoutTarget,
  selectHoldout,
} from "@/lib/rag/holdout";

export type AutotuneRunHeader = {
  recallK: number | null;
  recallMinRate: number | null;
  mrrK: number | null;
  mrrMinRate: number | null;
  ndcgK: number | null;
  ndcgMinRate: number | null;
  targeted: number;
  resolved: number;
  unresolved: number;
  improved: number; // still below the bar, but a targeted metric got better
  attempts: number;
  // Coverage (0065). `targeted`/`resolved` only read as a rate when the run
  // visited every chunk it targeted, and three things stop it before that.
  // null stopReason = it did.
  stopReason: AutotuneStopReason | null;
  chunksTotal: number;
  chunksSearched: number;
  // Holes in a sweep that otherwise looks complete (0068). `chunksFailed` counts
  // chunks whose search threw — they are in chunksSearched, because the run did
  // finish with them, it just finished badly. `tailStatus` is 'stuck' when the
  // re-score gave up on a dirty set that would not shrink and settled anyway;
  // separate from stopReason, which answers why the SEARCH stopped.
  chunksFailed: number;
  tailStatus: "stuck" | null;
  // The run's own test set and what it did to it (0074). Null when the config
  // had no holdout — which is NOT the same as "we were not recording", and the
  // columns stay null in both cases only because a config without a holdout has
  // nothing to record either way. Every reader gates on `holdout_n is not null`.
  holdout: HoldoutCapture | null;
};

// Everything a run freezes about the questions it was forbidden to see.
//
// `before` and `after` each carry BOTH sides. That is not redundancy with the
// dashboard's live numbers: the live split is today's membership over today's
// corpus, and this is the membership that existed while this run was deciding
// what to tune. Once syncHoldout redraws, only this survives.
export type HoldoutCapture = {
  // The dials that produced the draw, for display. Not an identity — see
  // holdoutSplitKey, which is.
  dials: { mode: HoldoutMode; size: number; seed: number } | null;
  splitKey: string;
  before: Split;
  after: Split;
  rows: HoldoutQuestionOutcome[];
};

// One held-out question's before → after. The complement of AutotuneOutcome: that
// type is a question the run TARGETED, this is one it was forbidden to see, and
// the shapes rhyme so the two can be read side by side.
//
// Per-metric columns rather than AutotuneOutcome's (metric, value) rows, because
// a targeted question has a metric it was targeted FOR and a held-out question
// does not — it is measured on all three or none.
export type HoldoutQuestionOutcome = {
  questionId: string;
  beforeHit: boolean | null;
  beforeRank: number | null;
  beforeRr: number | null;
  beforeNdcg: number | null;
  afterHit: boolean | null;
  afterRank: number | null;
  afterRr: number | null;
  afterNdcg: number | null;
};

// Why a run ended short. 'early' is stopEarly's bars-reached cutoff (0024) —
// the only one of these that is a SUCCESS, which is why callers must not
// collapse them into a single "incomplete" boolean. 'aborted' is the ending that
// used to have no name: prepareAutotune failing mid-run, i.e. the criteria were
// edited while the run was going, which left stop_reason null and made a
// truncated run read as a completed one.
//
// Do not gate UI on an allowlist of these — see leftWork in autotuneSlice.ts.
export type AutotuneStopReason = "budget" | "cancelled" | "early" | "aborted";

export type AutotuneOutcome = {
  questionId: string;
  sourceChunkId: string;
  metric: "recall" | "mrr" | "ndcg";
  beforeValue: number | null;
  beforeRank: number | null;
  afterValue: number | null;
  afterRank: number | null;
  overrideKind: string | null; // 'model' | 'size' | 'size+model' | null (no override)
  overrideModel: string | null;
  overrideSize: number | null;
};

// Persist a finished run: header + every targeted question's before→after, in
// one transaction so a half-written run never shows up in the audit trail.
//
// IDEMPOTENT UNDER A GIVEN id. The caller supplies one, generated when the run
// started, because a sliced run commits its work before its cursor moves — so the
// slice that writes this can die and be re-run, and "the audit trail gained a
// second copy of the same run" would be a worse failure than the one that rule
// exists to prevent. Re-running replaces the row and its outcomes rather than
// adding to them; the id is the run's identity, not a sequence number.
export async function insertAutotuneRun(
  runId: string,
  header: AutotuneRunHeader,
  outcomes: AutotuneOutcome[],
): Promise<string> {
  const cfg = activeConfig();
  const h = header.holdout;
  // Outside the transaction on purpose: it is a read over OTHER runs' rows, and
  // the answer cannot change by anything happening inside this one.
  const contaminated = h === null ? null : await holdoutContaminated(runId, h.rows.map((r) => r.questionId));
  return sql.begin(async (tx) => {
    await tx`delete from autotune_runs where id = ${runId} and config_id = ${cfg.id}`;
    const [run] = await tx<{ id: string }[]>`
      insert into autotune_runs
        (id, config_id, recall_k, recall_min_rate, mrr_k, mrr_min_rate,
         ndcg_k, ndcg_min_rate,
         targeted, resolved, unresolved, improved, attempts,
         stop_reason, chunks_total, chunks_searched, chunks_failed, tail_status,
         holdout_n, holdout_mode, holdout_size, holdout_seed,
         holdout_split_key, holdout_contaminated,
         train_n,
         train_recall_before, train_recall_after,
         train_mrr_before, train_mrr_after,
         train_ndcg_before, train_ndcg_after,
         holdout_recall_before, holdout_recall_after,
         holdout_mrr_before, holdout_mrr_after,
         holdout_ndcg_before, holdout_ndcg_after)
      values
        (${runId}, ${cfg.id}, ${header.recallK}, ${header.recallMinRate},
         ${header.mrrK}, ${header.mrrMinRate},
         ${header.ndcgK}, ${header.ndcgMinRate},
         ${header.targeted}, ${header.resolved}, ${header.unresolved},
         ${header.improved}, ${header.attempts},
         ${header.stopReason}, ${header.chunksTotal}, ${header.chunksSearched},
         ${header.chunksFailed}, ${header.tailStatus},
         ${h?.rows.length ?? null}, ${h?.dials?.mode ?? null},
         ${h?.dials?.size ?? null}, ${h?.dials?.seed ?? null},
         ${h?.splitKey ?? null}, ${contaminated},
         ${h?.after.train.n ?? null},
         ${h?.before.train.recall ?? null}, ${h?.after.train.recall ?? null},
         ${h?.before.train.mrr ?? null},    ${h?.after.train.mrr ?? null},
         ${h?.before.train.ndcg ?? null},   ${h?.after.train.ndcg ?? null},
         ${h?.before.holdout.recall ?? null}, ${h?.after.holdout.recall ?? null},
         ${h?.before.holdout.mrr ?? null},    ${h?.after.holdout.mrr ?? null},
         ${h?.before.holdout.ndcg ?? null},   ${h?.after.holdout.ndcg ?? null})
      returning id
    `;
    for (const o of outcomes) {
      await tx`
        insert into autotune_question_outcomes
          (autotune_run_id, eval_question_id, source_chunk_id, metric,
           before_value, before_rank, after_value, after_rank,
           override_kind, override_model, override_size)
        values
          (${run.id}, ${o.questionId}, ${o.sourceChunkId}, ${o.metric},
           ${o.beforeValue}, ${o.beforeRank}, ${o.afterValue}, ${o.afterRank},
           ${o.overrideKind}, ${o.overrideModel}, ${o.overrideSize})
      `;
    }
    // The durable snapshot. The delete above cascades to this table, so a
    // re-run slice replaces these rows rather than doubling them — the same
    // idempotency contract the outcomes rows have.
    for (const r of h?.rows ?? []) {
      await tx`
        insert into autotune_run_holdout
          (autotune_run_id, eval_question_id,
           before_hit, before_rank, before_rr, before_ndcg,
           after_hit, after_rank, after_rr, after_ndcg)
        values
          (${run.id}, ${r.questionId},
           ${r.beforeHit}, ${r.beforeRank}, ${r.beforeRr}, ${r.beforeNdcg},
           ${r.afterHit}, ${r.afterRank}, ${r.afterRr}, ${r.afterNdcg})
      `;
    }
    return run.id;
  });
}

// THE ONE-WAY DOOR, made automatic (0074).
//
// A holdout number only means "generalization" while the questions in it have
// never been tuned on. The moment an earlier run of this config TARGETED one of
// them — most obviously after the holdout was folded back in and a later run
// swept the whole set — every subsequent holdout delta is measuring optimization
// on questions the tuner has already seen. That is the pass-one/pass-two
// distinction docs/resume-metrics-results.md had to make by hand and by memory.
//
// Recorded on the row rather than derived at read time, because the join it
// depends on is against rows that are themselves deletable, and because the
// finding is about the run's own history: re-deriving it a year later from a
// pruned outcomes table would quietly clear a badge that was correct.
//
// Excludes THIS run's rows rather than filtering on created_at: the run being
// written is the newest one, so the two are equivalent, and `id <> runId` also
// holds when a re-run slice rewrites a row that already exists.
export async function holdoutContaminated(
  runId: string,
  heldOutQuestionIds: readonly string[],
): Promise<boolean> {
  if (heldOutQuestionIds.length === 0) return false;
  const cfg = activeConfig();
  const [row] = await sql<{ hit: boolean }[]>`
    select exists (
      select 1
      from autotune_question_outcomes o
      join autotune_runs r on r.id = o.autotune_run_id
      where r.config_id = ${cfg.id}
        and r.id <> ${runId}
        and o.eval_question_id = any(${[...heldOutQuestionIds]}::uuid[])
    ) as hit
  `;
  return row?.hit ?? false;
}

// Mark / unmark one question "ignore in rates" under the active config (§7 —
// manual false-positive mode). Config-scoped: the same question can be a legit
// miss in one config and distractor noise in another. Idempotent both ways.
export async function setQuestionIgnored(
  questionId: string,
  ignored: boolean,
  reason: string | null = null,
): Promise<void> {
  const cfg = activeConfig();
  if (ignored) {
    await sql`
      insert into config_question_ignores (config_id, eval_question_id, reason)
      values (${cfg.id}, ${questionId}, ${reason})
      on conflict (config_id, eval_question_id) do nothing
    `;
  } else {
    await sql`
      delete from config_question_ignores
      where config_id = ${cfg.id} and eval_question_id = ${questionId}
    `;
  }
}

// --- Holdout (0061) ---
//
// The test set is stored AS ignores, with reason 'holdout'. That buys exclusion
// from autotune targeting, from the confirm veto and from the keepBest sum for
// free, and the reason string is what keeps a redraw from eating a human's
// manual "ignore in rates" click. The consequence to know: un-ignoring a
// held-out question from /eval removes it from the test set until the next draw.

export const HOLDOUT_REASON = "holdout";

// Questions eligible for the draw: every labeled question in this config that
// isn't already ignored for a NON-holdout reason. Manually ignored questions are
// out of the rates anyway, so they could never be part of a measured test set —
// leaving them in the pool would only inflate the drawn count.
export async function listHoldoutCandidates(): Promise<HoldoutCandidate[]> {
  const cfg = activeConfig();
  const rows = await sql<{ eval_question_id: string; difficulty: string | null }[]>`
    select distinct q.id as eval_question_id, q.difficulty
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    left join config_question_ignores ig
      on ig.eval_question_id = q.id and ig.config_id = ${cfg.id}
    where de.config_id = ${cfg.id}
      and (ig.eval_question_id is null or ig.reason = ${HOLDOUT_REASON})
  `;
  return rows.map((r) => ({ questionId: r.eval_question_id, difficulty: r.difficulty }));
}

// The current test set. Read by the results step, which must compute holdout
// rates from per-question rows — held-out questions are still SCORED, they are
// just excluded from the dashboard's aggregates.
export async function listHoldoutQuestionIds(): Promise<Set<string>> {
  const cfg = activeConfig();
  const rows = await sql<{ eval_question_id: string }[]>`
    select eval_question_id from config_question_ignores
    where config_id = ${cfg.id} and reason = ${HOLDOUT_REASON}
  `;
  return new Set(rows.map((r) => r.eval_question_id));
}

// Draw (or clear) the test set for the active config from its saved settings.
// Idempotent: the same settings over the same questions produce the same rows,
// so calling it on every settings save is a no-op unless something moved.
export async function syncHoldout(
  settings: HoldoutSettings,
): Promise<{ total: number; held: number }> {
  const cfg = activeConfig();
  const current = await listHoldoutQuestionIds();

  if (!settings.enabled) {
    if (current.size > 0) {
      await sql`
        delete from config_question_ignores
        where config_id = ${cfg.id} and reason = ${HOLDOUT_REASON}
      `;
    }
    const [row] = await sql<{ n: number }[]>`
      select count(distinct q.id)::int as n
      from eval_questions q
      join eval_labels l on l.eval_question_id = q.id
      join document_embeddings de on de.id = l.document_embedding_id
      where de.config_id = ${cfg.id}
    `;
    return { total: row?.n ?? 0, held: 0 };
  }

  const candidates = await listHoldoutCandidates();
  const picked = selectHoldout(
    candidates,
    holdoutTarget(candidates.length, settings),
    settings.seed,
    current,
  );

  // One transaction: a half-applied redraw would leave the config with a test
  // set that matches neither the old settings nor the new ones.
  await sql.begin(async (tx) => {
    await tx`
      delete from config_question_ignores
      where config_id = ${cfg.id} and reason = ${HOLDOUT_REASON}
        and eval_question_id <> all(${picked}::uuid[])
    `;
    if (picked.length > 0) {
      await tx`
        insert into config_question_ignores (config_id, eval_question_id, reason)
        select ${cfg.id}, id, ${HOLDOUT_REASON}
        from unnest(${picked}::uuid[]) as id
        on conflict (config_id, eval_question_id) do nothing
      `;
    }
  });
  return { total: candidates.length, held: picked.length };
}

// Question ids the active config has marked "ignore in rates" — excluded from
// autotune targeting (§5.1). Tolerates the table not existing yet (0014
// unapplied) the same way listOverrides tolerates a missing 0013 table.
export async function listIgnoredQuestionIds(): Promise<Set<string>> {
  const cfg = activeConfig();
  try {
    const rows = await sql<{ eval_question_id: string }[]>`
      select eval_question_id from config_question_ignores
      where config_id = ${cfg.id}
    `;
    return new Set(rows.map((r) => r.eval_question_id));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return new Set();
    throw err;
  }
}

// --- Reading the frozen holdout back (0074) ---------------------------------

// A metric measured at both ends of one run. Never a single number: a holdout
// value with no train value beside it is the misreading this whole feature
// exists to prevent, so the shape refuses to carry one alone.
export type MetricDelta = { before: number | null; after: number | null };

export type HoldoutRunSummary = {
  runId: string;
  createdAt: number;
  dials: { mode: string; size: number; seed: number } | null;
  // Two runs are comparable iff these match. Null only for a run whose members
  // were somehow not recorded; `holdout_n is not null` is what gets it listed.
  splitKey: string | null;
  contaminated: boolean;
  train: { n: number; recall: MetricDelta; mrr: MetricDelta; ndcg: MetricDelta };
  holdout: { n: number; recall: MetricDelta; mrr: MetricDelta; ndcg: MetricDelta };
};

type HoldoutRunRow = {
  id: string;
  created_at: Date;
  holdout_n: number;
  holdout_mode: string | null;
  holdout_size: number | null;
  holdout_seed: number | null;
  holdout_split_key: string | null;
  holdout_contaminated: boolean | null;
  train_n: number | null;
  train_recall_before: number | null; train_recall_after: number | null;
  train_mrr_before: number | null; train_mrr_after: number | null;
  train_ndcg_before: number | null; train_ndcg_after: number | null;
  holdout_recall_before: number | null; holdout_recall_after: number | null;
  holdout_mrr_before: number | null; holdout_mrr_after: number | null;
  holdout_ndcg_before: number | null; holdout_ndcg_after: number | null;
};

// Every run of the active config that recorded a holdout, newest first.
//
// Runs with `holdout_n is null` are OMITTED rather than shown with dashes. They
// are not runs that held nothing out; they are runs from before the recording
// existed, and a row of dashes would invite the reader to treat their absence as
// a measurement. Runs that genuinely held nothing out never set the column
// either, and have nothing to say here for the same reason.
export async function listHoldoutRuns(): Promise<HoldoutRunSummary[]> {
  const cfg = activeConfig();
  const rows = await sql<HoldoutRunRow[]>`
    select id, created_at, holdout_n, holdout_mode, holdout_size, holdout_seed,
           holdout_split_key, holdout_contaminated, train_n,
           train_recall_before, train_recall_after,
           train_mrr_before, train_mrr_after,
           train_ndcg_before, train_ndcg_after,
           holdout_recall_before, holdout_recall_after,
           holdout_mrr_before, holdout_mrr_after,
           holdout_ndcg_before, holdout_ndcg_after
    from autotune_runs
    where config_id = ${cfg.id} and holdout_n is not null
    order by created_at desc
  `;
  return rows.map((r) => ({
    runId: r.id,
    createdAt: r.created_at.getTime(),
    dials:
      r.holdout_mode === null || r.holdout_size === null || r.holdout_seed === null
        ? null
        : { mode: r.holdout_mode, size: r.holdout_size, seed: r.holdout_seed },
    splitKey: r.holdout_split_key,
    contaminated: r.holdout_contaminated ?? false,
    train: {
      n: r.train_n ?? 0,
      recall: { before: r.train_recall_before, after: r.train_recall_after },
      mrr: { before: r.train_mrr_before, after: r.train_mrr_after },
      ndcg: { before: r.train_ndcg_before, after: r.train_ndcg_after },
    },
    holdout: {
      n: r.holdout_n,
      recall: { before: r.holdout_recall_before, after: r.holdout_recall_after },
      mrr: { before: r.holdout_mrr_before, after: r.holdout_mrr_after },
      ndcg: { before: r.holdout_ndcg_before, after: r.holdout_ndcg_after },
    },
  }));
}

// One held-out question as the run left it, with its text — what the expanded
// row shows. The headline "N improved / M regressed" is a count over these, not
// a stored number, so it can never disagree with the list underneath it.
export type HoldoutRunQuestion = HoldoutQuestionOutcome & {
  question: string;
  difficulty: string | null;
};

// The per-question detail for one run. Config-scoped through the run row, so a
// run id from another user's config returns nothing rather than someone else's
// questions.
export async function listHoldoutRunQuestions(runId: string): Promise<HoldoutRunQuestion[]> {
  const cfg = activeConfig();
  const rows = await sql<
    {
      eval_question_id: string;
      question: string;
      difficulty: string | null;
      before_hit: boolean | null; before_rank: number | null;
      before_rr: number | null; before_ndcg: number | null;
      after_hit: boolean | null; after_rank: number | null;
      after_rr: number | null; after_ndcg: number | null;
    }[]
  >`
    select h.eval_question_id, q.question, q.difficulty,
           h.before_hit, h.before_rank, h.before_rr, h.before_ndcg,
           h.after_hit, h.after_rank, h.after_rr, h.after_ndcg
    from autotune_run_holdout h
    join autotune_runs r on r.id = h.autotune_run_id
    join eval_questions q on q.id = h.eval_question_id
    where h.autotune_run_id = ${runId} and r.config_id = ${cfg.id}
    order by q.question
  `;
  return rows.map((r) => ({
    questionId: r.eval_question_id,
    question: r.question,
    difficulty: r.difficulty,
    beforeHit: r.before_hit,
    beforeRank: r.before_rank,
    beforeRr: r.before_rr,
    beforeNdcg: r.before_ndcg,
    afterHit: r.after_hit,
    afterRank: r.after_rank,
    afterRr: r.after_rr,
    afterNdcg: r.after_ndcg,
  }));
}
