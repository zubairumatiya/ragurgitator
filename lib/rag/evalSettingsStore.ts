// ---------------------------------------------------------------------------
// DB layer for per-config EVAL CRITERIA (migration 0014, Phase A of
// docs/eval-autotuning-plan.md). Raw SQL via the shared `sql` client.
//
// Criteria live on the `configs` row (D3) but are loaded SEPARATELY from
// ResolvedConfig (lib/rag/activeConfig.ts) — retrieval is hot and doesn't need
// them, while only the eval flows (generate/score/summary) and the Settings UI
// do. `k` is stored nullable: null means "fall back to the config's top_k" (A1).
//
// The autotune.* fields are saved here now (the Settings dropdown edits them) but
// aren't consumed until the Phase C engine lands.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig, isUuid } from "@/lib/rag/activeConfig";
import type { Difficulty } from "@/lib/rag/eval";
import { noteFusionPoolChange } from "@/lib/rag/overrideStore";

export type MetricCriteria = {
  enabled: boolean;
  k: number | null; // null => use the config's top_k
  minRate: number | null; // null => metric runs but isn't an autotune target
};

export type AutotuneApply = "choose" | "auto_best";
export type AutotuneSearch = "first_success" | "exhaustive";

export type AutotuneSettings = {
  sizeLadder: number[];
  overlapPct: number; // overlap tokens = round(size * overlapPct)
  apply: AutotuneApply;
  search: AutotuneSearch;
  // Halt the run once every targeted metric's aggregate rate reaches its
  // min-rate, skipping the remaining below-bar chunks (0024).
  stopEarly: boolean;
  // When no candidate clears a chunk's bar, keep the best strictly-improving
  // one anyway — still confirmed through real retrieval, reported as
  // "improved" rather than resolved (0026).
  keepBest: boolean;
  // Restrict runs to these source chunk ids (0025). null = ALL chunks,
  // including ones labeled after the setting was saved.
  chunkScope: string[] | null;
  // Fusion pool for the trial dry-runs only (0027): how many base candidates
  // each trial re-embeds under a candidate model. null = follow live
  // retrieval's pool. Search-only — the confirm re-score stays on the live
  // pool, so a small value just risks more confirm-time reverts.
  fusionPool: number | null;
};

export type RetrievalSettings = {
  // Live-retrieval fusion pool (0027) — mirrors ResolvedConfig.fusionPool,
  // surfaced here so the Settings dropdown can edit it. null = auto
  // (max(top_k * 4, 50)). Changing it changes fusion ranks, so saving a new
  // value stales scored results whenever overrides exist (fingerprinted in
  // overrideStore.retrievalStateFingerprint).
  fusionPool: number | null;
};

export type EvalCriteria = {
  recall: MetricCriteria;
  mrr: MetricCriteria;
  ndcg: MetricCriteria;
  difficulties: Difficulty[]; // '{}' => legacy no-difficulty generation
  autotune: AutotuneSettings;
  retrieval: RetrievalSettings;
};

type CriteriaRow = {
  recall_enabled: boolean;
  recall_k: number | null;
  recall_min_rate: number | null;
  mrr_enabled: boolean;
  mrr_k: number | null;
  mrr_min_rate: number | null;
  ndcg_enabled: boolean;
  ndcg_k: number | null;
  ndcg_min_rate: number | null;
  eval_difficulties: string[];
  autotune_size_ladder: number[];
  autotune_overlap_pct: number;
  autotune_apply: string;
  autotune_search: string;
  autotune_stop_early: boolean;
  autotune_keep_best: boolean;
  autotune_chunk_scope: string[] | null;
  autotune_fusion_pool: number | null;
  retrieval_fusion_pool: number | null;
};

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

function toCriteria(row: CriteriaRow): EvalCriteria {
  return {
    recall: { enabled: row.recall_enabled, k: row.recall_k, minRate: row.recall_min_rate },
    mrr: { enabled: row.mrr_enabled, k: row.mrr_k, minRate: row.mrr_min_rate },
    ndcg: { enabled: row.ndcg_enabled, k: row.ndcg_k, minRate: row.ndcg_min_rate },
    // Keep only recognised difficulties, in the canonical easy→hard order.
    difficulties: DIFFICULTIES.filter((d) => row.eval_difficulties.includes(d)),
    autotune: {
      sizeLadder: row.autotune_size_ladder,
      overlapPct: row.autotune_overlap_pct,
      apply: row.autotune_apply === "auto_best" ? "auto_best" : "choose",
      search: row.autotune_search === "exhaustive" ? "exhaustive" : "first_success",
      stopEarly: row.autotune_stop_early,
      keepBest: row.autotune_keep_best,
      chunkScope: row.autotune_chunk_scope,
      fusionPool: row.autotune_fusion_pool,
    },
    retrieval: { fusionPool: row.retrieval_fusion_pool },
  };
}

const COLUMNS = sql`
  recall_enabled, recall_k, recall_min_rate,
  mrr_enabled, mrr_k, mrr_min_rate,
  ndcg_enabled, ndcg_k, ndcg_min_rate,
  eval_difficulties,
  autotune_size_ladder, autotune_overlap_pct, autotune_apply, autotune_search,
  autotune_stop_early, autotune_keep_best, autotune_chunk_scope,
  autotune_fusion_pool, retrieval_fusion_pool
`;

// Criteria for a specific config; null when the id is malformed / missing.
export async function getCriteria(configId: string): Promise<EvalCriteria | null> {
  if (!isUuid(configId)) return null;
  const rows = await sql<CriteriaRow[]>`
    select ${COLUMNS} from configs where id = ${configId} limit 1
  `;
  return rows.length > 0 ? toCriteria(rows[0]) : null;
}

// Criteria for the active config (eval engine). Throws if the row vanished.
export async function getActiveCriteria(): Promise<EvalCriteria> {
  const c = await getCriteria(activeConfig().id);
  if (!c) throw new Error("Active config has no criteria row.");
  return c;
}

// A nested partial — the Settings UI sends only the fields it changed.
export type CriteriaPatch = {
  recall?: Partial<MetricCriteria>;
  mrr?: Partial<MetricCriteria>;
  ndcg?: Partial<MetricCriteria>;
  difficulties?: Difficulty[];
  autotune?: Partial<AutotuneSettings>;
  retrieval?: Partial<RetrievalSettings>;
};

// Read-merge-write: load the current criteria, overlay the patch, write every
// column back. One extra SELECT, but a settings save is rare and this keeps the
// UPDATE static (no dynamic column assembly). Returns the merged criteria.
export async function updateCriteria(
  configId: string,
  patch: CriteriaPatch,
): Promise<EvalCriteria | null> {
  const cur = await getCriteria(configId);
  if (!cur) return null;

  const next: EvalCriteria = {
    recall: { ...cur.recall, ...patch.recall },
    mrr: { ...cur.mrr, ...patch.mrr },
    ndcg: { ...cur.ndcg, ...patch.ndcg },
    difficulties: patch.difficulties
      ? DIFFICULTIES.filter((d) => patch.difficulties!.includes(d))
      : cur.difficulties,
    autotune: { ...cur.autotune, ...patch.autotune },
    retrieval: { ...cur.retrieval, ...patch.retrieval },
  };

  await sql`
    update configs set
      recall_enabled      = ${next.recall.enabled},
      recall_k            = ${next.recall.k},
      recall_min_rate     = ${next.recall.minRate},
      mrr_enabled         = ${next.mrr.enabled},
      mrr_k               = ${next.mrr.k},
      mrr_min_rate        = ${next.mrr.minRate},
      ndcg_enabled        = ${next.ndcg.enabled},
      ndcg_k              = ${next.ndcg.k},
      ndcg_min_rate       = ${next.ndcg.minRate},
      eval_difficulties   = ${next.difficulties},
      autotune_size_ladder = ${next.autotune.sizeLadder},
      autotune_overlap_pct = ${next.autotune.overlapPct},
      autotune_apply      = ${next.autotune.apply},
      autotune_search     = ${next.autotune.search},
      autotune_stop_early = ${next.autotune.stopEarly},
      autotune_keep_best  = ${next.autotune.keepBest},
      autotune_chunk_scope = ${next.autotune.chunkScope}::uuid[],
      autotune_fusion_pool = ${next.autotune.fusionPool},
      retrieval_fusion_pool = ${next.retrieval.fusionPool},
      updated_at          = now()
    where id = ${configId}
  `;
  // A live-pool change reshapes fusion ranks for every query — stamp + log it
  // so the stale badge can explain (no-op while the config has no overrides).
  if (next.retrieval.fusionPool !== cur.retrieval.fusionPool) {
    await noteFusionPoolChange(cur.retrieval.fusionPool, next.retrieval.fusionPool);
  }
  return next;
}

// Add one difficulty to the active config's mix (idempotent) — backs the
// "Bulk actions → Add question → {easy|medium|hard}" corpus-wide generate.
export async function addDifficulty(difficulty: Difficulty): Promise<EvalCriteria | null> {
  const cur = await getActiveCriteria();
  if (cur.difficulties.includes(difficulty)) return cur;
  return updateCriteria(activeConfig().id, {
    difficulties: [...cur.difficulties, difficulty],
  });
}

// The effective k for a metric: its own k, or the config's top_k when unset (A1).
export function effectiveK(metric: MetricCriteria, topK: number): number {
  return metric.k ?? topK;
}

// The retrieval depth one scoring pass needs: the largest enabled metric k, so a
// single retrieved list serves Recall@recall_k, MRR@mrr_k, and nDCG@ndcg_k (A1).
// Falls back to top_k when no metric is enabled.
export function retrievalDepth(criteria: EvalCriteria, topK: number): number {
  const ks: number[] = [];
  if (criteria.recall.enabled) ks.push(effectiveK(criteria.recall, topK));
  if (criteria.mrr.enabled) ks.push(effectiveK(criteria.mrr, topK));
  if (criteria.ndcg.enabled) ks.push(effectiveK(criteria.ndcg, topK));
  return ks.length > 0 ? Math.max(...ks) : topK;
}
