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
  improved: number; // still below the bar, but a targeted metric got better
  attempts: number;
  // Wall clock (0041). The engine already measured all of this; these fields are
  // where it lands. The three phases do NOT sum to durationMs — the remainder
  // (getSummary/splitText/etc.) is real and the Trial times tab shows it as
  // "other". Null on a run that predates the migration.
  durationMs: number | null;
  searchMs: number | null;
  confirmMs: number | null;
  rescoreMs: number | null;
  // Groups the N runs of one timing experiment; null = an ad-hoc dashboard run.
  trialLabel: string | null;
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
         targeted, resolved, unresolved, improved, attempts,
         duration_ms, search_ms, confirm_ms, rescore_ms, trial_label)
      values
        (${cfg.id}, ${header.recallK}, ${header.recallMinRate},
         ${header.mrrK}, ${header.mrrMinRate},
         ${header.ndcgK}, ${header.ndcgMinRate},
         ${header.targeted}, ${header.resolved}, ${header.unresolved},
         ${header.improved}, ${header.attempts},
         ${header.durationMs}, ${header.searchMs}, ${header.confirmMs},
         ${header.rescoreMs}, ${header.trialLabel})
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

// --- Trial times (0041) ----------------------------------------------------

// One timed run, as the Trial times tab reads it. `otherMs` is the unaccounted
// remainder — the phases deliberately don't sum to the total, so surfacing the
// gap is the point rather than an accident (see 0041's header).
export type TrialRun = {
  id: string;
  createdAt: Date;
  durationMs: number;
  searchMs: number;
  confirmMs: number;
  rescoreMs: number;
  otherMs: number;
  targeted: number;
  attempts: number;
  resolved: number;
};


// A group of runs sharing one trial_label, plus the medians that make two
// groups comparable. Ad-hoc dashboard runs (null label) group under "ad-hoc".
export type TrialGroup = {
  label: string;
  runs: TrialRun[];
  medianDurationMs: number;
  medianSearchMs: number;
  medianConfirmMs: number;
  medianRescoreMs: number;
  medianOtherMs: number;
  // Whether every run in the group faced the same workload. Differing values
  // mean the runs aren't comparable and the median is meaningless — the whole
  // reason the harness resets overrides between runs.
  targetedStable: boolean;
};

// MEDIAN, not mean: this work is network-bound with a long right tail, so one
// slow run drags a mean enough to read as a regression. Even count takes the
// lower-middle element — no interpolation, so the number is always a real run.
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Timed autotune runs for one config, newest group first. Runs from before 0041
// have no duration and are skipped outright — a row with no clock can't join a
// timing comparison, and showing it as 0 would poison the medians.
export async function listTrialRuns(configId: string): Promise<TrialGroup[]> {
  const rows = await sql<
    {
      id: string;
      created_at: Date;
      trial_label: string | null;
      duration_ms: number;
      search_ms: number | null;
      confirm_ms: number | null;
      rescore_ms: number | null;
      targeted: number;
      attempts: number;
      resolved: number;
    }[]
  >`
    select id, created_at, trial_label, duration_ms, search_ms, confirm_ms,
           rescore_ms, targeted, attempts, resolved
    from autotune_runs
    where config_id = ${configId} and duration_ms is not null
    order by created_at desc
  `;

  const groups = new Map<string, TrialRun[]>();
  for (const r of rows) {
    const search = r.search_ms ?? 0;
    const confirm = r.confirm_ms ?? 0;
    const rescore = r.rescore_ms ?? 0;
    const label = r.trial_label ?? "ad-hoc";
    const list = groups.get(label) ?? [];
    list.push({
      id: r.id,
      createdAt: r.created_at,
      durationMs: r.duration_ms,
      searchMs: search,
      confirmMs: confirm,
      rescoreMs: rescore,
      // Clamped at 0: the phases are measured independently of the total, so
      // rounding can in principle push the sum a millisecond past it.
      otherMs: Math.max(0, r.duration_ms - search - confirm - rescore),
      targeted: r.targeted,
      attempts: r.attempts,
      resolved: r.resolved,
    });
    groups.set(label, list);
  }

  return [...groups.entries()].map(([label, runs]) => {
    // Only runs that carry a split take part in its median — a pre-0042 run
    // would otherwise enter as a bucket of zeros and halve the group's numbers.
    return {
      label,
      runs,
      medianDurationMs: median(runs.map((r) => r.durationMs)),
      medianSearchMs: median(runs.map((r) => r.searchMs)),
      medianConfirmMs: median(runs.map((r) => r.confirmMs)),
      medianRescoreMs: median(runs.map((r) => r.rescoreMs)),
      medianOtherMs: median(runs.map((r) => r.otherMs)),
      targetedStable: new Set(runs.map((r) => r.targeted)).size === 1,
    };
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
