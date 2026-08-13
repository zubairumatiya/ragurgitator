// DB layer for autotune run history (migration 0016, Phase C of
// docs/eval-autotuning-plan.md) plus the config-scoped question ignores the
// engine must exclude from targeting (0014's config_question_ignores — written
// by the Phase D "ignore in rates" UI, but respected here from day one) and the
// holdout draw that reuses that same table (0061).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config.
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  type HoldoutCandidate,
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
};

// Why a run ended short. 'early' is stopEarly's bars-reached cutoff (0024) —
// the only one of the three that is a SUCCESS, which is why callers must not
// collapse these into a single "incomplete" boolean.
export type AutotuneStopReason = "budget" | "cancelled" | "early";

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
  return sql.begin(async (tx) => {
    await tx`delete from autotune_runs where id = ${runId} and config_id = ${cfg.id}`;
    const [run] = await tx<{ id: string }[]>`
      insert into autotune_runs
        (id, config_id, recall_k, recall_min_rate, mrr_k, mrr_min_rate,
         ndcg_k, ndcg_min_rate,
         targeted, resolved, unresolved, improved, attempts,
         stop_reason, chunks_total, chunks_searched)
      values
        (${runId}, ${cfg.id}, ${header.recallK}, ${header.recallMinRate},
         ${header.mrrK}, ${header.mrrMinRate},
         ${header.ndcgK}, ${header.ndcgMinRate},
         ${header.targeted}, ${header.resolved}, ${header.unresolved},
         ${header.improved}, ${header.attempts},
         ${header.stopReason}, ${header.chunksTotal}, ${header.chunksSearched})
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
    return run.id;
  });
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
