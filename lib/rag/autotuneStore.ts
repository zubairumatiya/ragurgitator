// ---------------------------------------------------------------------------
// DB layer for autotune run history (migration 0016, Phase C of
// docs/eval-autotuning-plan.md) plus the config-scoped question ignores the
// engine must exclude from targeting (0014's config_question_ignores — written
// by the Phase D "ignore in rates" UI, but respected here from day one).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";

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
  attempts: number;
};

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
export async function insertAutotuneRun(
  header: AutotuneRunHeader,
  outcomes: AutotuneOutcome[],
): Promise<string> {
  const cfg = activeConfig();
  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into autotune_runs
        (config_id, recall_k, recall_min_rate, mrr_k, mrr_min_rate,
         ndcg_k, ndcg_min_rate,
         targeted, resolved, unresolved, attempts)
      values
        (${cfg.id}, ${header.recallK}, ${header.recallMinRate},
         ${header.mrrK}, ${header.mrrMinRate},
         ${header.ndcgK}, ${header.ndcgMinRate},
         ${header.targeted}, ${header.resolved}, ${header.unresolved},
         ${header.attempts})
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
