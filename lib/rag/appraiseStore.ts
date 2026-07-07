// ---------------------------------------------------------------------------
// DB layer for the Appraise tab — CROSS-CONFIG comparison (multi-config-plan §8,
// Phase 4). Unlike the other stores this is deliberately NOT scoped to one active
// config: it reads every config's latest frozen eval-run snapshot so they can be
// compared side by side. Raw SQL via the shared `sql` client.
//
// Uses the eval_runs snapshots (config_id added in 0011) rather than recomputing,
// so Appraise is cheap and reflects exactly what each config last measured. A
// config that has never been scored has no run row → null metrics.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";

export type ConfigComparison = {
  configId: string;
  label: string; // config name, or a default settings-based label
  isOpen: boolean;
  corpusId: string | null; // null = detached config (corpus deleted)
  corpusName: string | null;
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  // Latest eval-run snapshot; null fields when the config has never been scored.
  k: number | null;
  questionCount: number | null; // questions scored in that run
  recall: number | null; // hit_count / question_count
  mrr: number | null;
  ndcg: number | null;
  lastRunAt: number | null;
};

// Every config (open and closed) with its latest eval metrics, grouped-ready:
// ordered by corpus then tab order, so same-corpus A/Bs are adjacent.
export async function listConfigComparisons(): Promise<ConfigComparison[]> {
  const rows = await sql<
    {
      id: string;
      name: string | null;
      is_open: boolean;
      base_model: string;
      chunk_size: number;
      chunk_overlap: number;
      top_k: number;
      corpus_id: string | null;
      corpus_name: string | null;
      k: number | null;
      question_count: number | null;
      hit_count: number | null;
      mrr: number | null;
      ndcg: number | null;
      run_at: Date | null;
    }[]
  >`
    select
      c.id, c.name, c.is_open, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
      co.id as corpus_id, co.name as corpus_name,
      r.k, r.question_count, r.hit_count, r.mrr, r.ndcg, r.created_at as run_at
    from configs c
    left join corpora co on co.id = c.corpus_id
    left join lateral (
      select k, question_count, hit_count, mrr, ndcg, created_at
      from eval_runs er
      where er.config_id = c.id
      order by er.created_at desc
      limit 1
    ) r on true
    order by co.created_at nulls last, co.id, c.tab_order, c.created_at
  `;

  return rows.map((r) => ({
    configId: r.id,
    label: r.name ?? `${r.base_model} · ${r.chunk_size}/${r.chunk_overlap}`,
    isOpen: r.is_open,
    corpusId: r.corpus_id,
    corpusName: r.corpus_name,
    baseModel: r.base_model,
    chunkSize: r.chunk_size,
    chunkOverlap: r.chunk_overlap,
    topK: r.top_k,
    k: r.k,
    questionCount: r.question_count,
    recall:
      r.question_count && r.question_count > 0 && r.hit_count !== null
        ? r.hit_count / r.question_count
        : null,
    mrr: r.mrr,
    ndcg: r.ndcg,
    lastRunAt: r.run_at ? r.run_at.getTime() : null,
  }));
}
