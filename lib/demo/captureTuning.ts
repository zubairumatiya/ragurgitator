// BANKING THE AUTOTUNE WINNER — phase 6 of docs/demo-real-flow-plan.md.
//
// Step 6 of the walk is ⚙ Auto tune, and it is the only step of the six that was
// never blocked: with the frozen set holding it to twelve questions it was
// affordable, so lib/demo/policy deliberately left it out of DEMO_ACTIONS. §3.2
// removed that bound — a visitor now builds a sixty-question board — and the
// search is per failing chunk per candidate rung of real embedding spend, so what
// used to be the walk's finale becomes the step that ends in the budget panel.
//
// SO THE SEARCH IS REPLAYED AND NOTHING ELSE IS. The master has already searched
// these chunks and confirmed its winners through real retrieval; this module
// copies the winners onto the shelf lib/demo/replay owns, and a guest's press
// installs them and then re-scores and reports FOR REAL over its own questions.
// Which half is which is the sentence the UI owes the visitor
// (lib/demo/policy.PUBLISHED_SEARCH_NOTE), and it is why nothing downstream of
// the install is copied: no autotune_runs row, no eval_results, no rates.
//
// THE TRIALS COME WITH THE OVERRIDE, deliberately. A chunk card's "Models tried"
// list is eval_model_trials, and banking a winner without them leaves the panel a
// visitor opens next empty — exactly the failure lib/demo/policy's header calls
// out, a consolation pointing at a table the clone does not carry.
//
// THIS MODULE READS THE MASTER through privilegedSql, like lib/demo/captureRankings
// and every other publish-time step in scripts/demo-snapshot: a script has no
// request scope, so the request-scoped `sql` would throw before it read.
import "server-only";

import { privilegedSql } from "@/lib/db";
import { modelSpec } from "@/lib/rag/embeddingModels";
import {
  packEmbedding,
  type ReplayTrialOutcome,
  type ReplayTuning,
  type ReplayTuningEntry,
  type ReplayTuningTrial,
} from "@/lib/demo/replayCore";

// What the dry run reports: how much of the board the master has actually tuned.
// A shortfall here is not a failure — a chunk the master never overrode is a
// chunk its own search found nothing for, and the replayed run reports it
// unresolved exactly as a real one would — but it IS the number that decides
// whether pressing the button does anything at all.
export type TuningCensus = {
  boardChunks: number;
  overridden: number;
  overrideRows: number;
  trials: number;
  // Of `overridden`, the ones whose winning model the guest CANNOT embed under —
  // see servableBy. Dropped from the bank, reported here so a publish that loses
  // half the shelf to a provider the demo has no key for says so out loud.
  foreign: number;
};

export async function tuningCensus(
  configId: string,
  board: string[],
  baseModel: string,
): Promise<TuningCensus> {
  if (board.length === 0) {
    return { boardChunks: 0, overridden: 0, overrideRows: 0, trials: 0, foreign: 0 };
  }
  const [row] = await privilegedSql<
    { overridden: number; rows: number; trials: number; models: string[] }[]
  >`
    select
      (select count(distinct source_chunk_id) from config_chunk_overrides
        where config_id = ${configId} and source_chunk_id = any(${board}::uuid[]))::int as overridden,
      (select count(*) from config_chunk_overrides
        where config_id = ${configId} and source_chunk_id = any(${board}::uuid[]))::int as rows,
      (select count(*) from eval_model_trials t
         join document_embeddings de on de.id = t.document_embedding_id
        where de.config_id = ${configId} and t.source_chunk_id = any(${board}::uuid[]))::int as trials,
      (select coalesce(array_agg(distinct model), '{}') from config_chunk_overrides
        where config_id = ${configId} and source_chunk_id = any(${board}::uuid[])) as models
  `;
  const foreign = await privilegedSql<{ n: number }[]>`
    select count(distinct source_chunk_id)::int as n from config_chunk_overrides
     where config_id = ${configId} and source_chunk_id = any(${board}::uuid[])
       and model <> all(${(row?.models ?? []).filter((m) => servableBy(m, baseModel))}::text[])
  `;
  return {
    boardChunks: board.length,
    overridden: row?.overridden ?? 0,
    overrideRows: row?.rows ?? 0,
    trials: row?.trials ?? 0,
    foreign: foreign[0]?.n ?? 0,
  };
}

// CAN THE GUEST EMBED UNDER THIS MODEL AT ALL?
//
// THE DEFECT THIS EXISTS FOR, found in a browser and only there. A guest carries
// exactly ONE credential — the operator's Voyage key (lib/demo/config) — and an
// override changes retrieval for EVERY query: with one in place the retriever
// takes the fusion path and embeds the query under each override's model. The
// master's own autotune ranged over every provider it has a key for, so ~a fifth
// of its board winners are OpenAI's; installing one of those turned the next
// re-score — and every later question — into "No openai API key", from a button
// whose whole promise is that it spends nothing.
//
// So the bank carries only what the demo's key covers, by PROVIDER of the
// config's own base model rather than by a hard-coded "voyage": the rule is "the
// credential this workspace already has", and a demo published on another
// provider's corpus should inherit it rather than a list to keep in sync.
//
// A chunk dropped here is a chunk with no banked winner, which the replay
// already has an honest answer for: it reports it unresolved, exactly as it does
// for a chunk the master's search never cracked.
function servableBy(model: string, baseModel: string): boolean {
  try {
    return modelSpec(model).provider === modelSpec(baseModel).provider;
  } catch {
    return false; // a model this build no longer knows about
  }
}

type OverrideRow = {
  source_chunk_id: string;
  model: string;
  kind: string;
  text: string | null;
  dimension: number;
  embedding: number[];
  token_start: number | null;
  token_end: number | null;
};

type TrialRow = {
  source_chunk_id: string;
  baseline_model: string;
  trial_model: string;
  kind: string;
  chunk_size: number | null;
  chunk_overlap: number | null;
  piece_count: number | null;
  k: number;
  pool_chunk_ids: string[];
  results: ({ question?: string } & Record<string, unknown>)[];
};

// The change-log phrasing this override would have been written with. Composed
// here rather than left to setChunkOverridePieces' fallback because the fallback
// is written for the by-hand path ("delegate → voyage-3.5") and says nothing
// about the shape a size search found — which is the interesting half of what
// the master's run actually did.
function detailFor(row: OverrideRow, pieces: number): string {
  if (row.kind === "model") return `delegate → ${row.model}`;
  const shape = `re-split into ${pieces} piece${pieces === 1 ? "" : "s"}`;
  return row.kind === "size" ? shape : `${shape} under ${row.model}`;
}

// THE BANKED FORM, board-scoped and never wider (§6: the master's 274 override
// rows are ~1.15 MB, and the ones outside the board name chunks no visitor will
// ever autotune).
export async function packTuning(
  configId: string,
  board: string[],
  baseModel: string,
): Promise<ReplayTuning> {
  if (board.length === 0) return { version: 1, entries: [] };

  const overrides = await privilegedSql<OverrideRow[]>`
    select o.source_chunk_id, o.model, o.kind, o.text, o.dimension,
           o.embedding::real[] as embedding, o.token_start, o.token_end
      from config_chunk_overrides o
     where o.config_id = ${configId}
       and o.source_chunk_id = any(${board}::uuid[])
     order by o.source_chunk_id, o.piece_index
  `;

  const trials = await privilegedSql<TrialRow[]>`
    select t.source_chunk_id, t.baseline_model, t.trial_model, t.kind,
           t.chunk_size, t.chunk_overlap, t.piece_count, t.k,
           t.pool_chunk_ids, t.results
      from eval_model_trials t
      join document_embeddings de on de.id = t.document_embedding_id
     where de.config_id = ${configId}
       and t.source_chunk_id = any(${board}::uuid[])
     order by t.source_chunk_id, t.created_at desc
  `;

  // Grouped by chunk before the entries are built, so a chunk with an override
  // and no trial and a chunk with a trial and no override are both handled by
  // the one rule below: NO OVERRIDE, NO ENTRY. A banked trial without the
  // winning vector is a "Models tried" list for a tuning that never landed.
  const trialsByChunk = new Map<string, ReplayTuningTrial[]>();
  for (const t of trials) {
    const results: ReplayTrialOutcome[] = [];
    for (const r of t.results ?? []) {
      // Keyed by wording; a stored row without one is from a shape that predates
      // the field and cannot be re-resolved in the guest's workspace.
      if (typeof r.question !== "string") continue;
      results.push({
        question: r.question,
        storedHit: (r.storedHit as boolean | null) ?? null,
        storedRank: (r.storedRank as number | null) ?? null,
        newHit: Boolean(r.newHit),
        newRank: Number(r.newRank ?? 0),
        newScore: Number(r.newScore ?? 0),
        ...(typeof r.fusedRank === "number" ? { fusedRank: r.fusedRank } : {}),
        ...(typeof r.fusedHit === "boolean" ? { fusedHit: r.fusedHit } : {}),
      });
    }
    const forChunk = trialsByChunk.get(t.source_chunk_id) ?? [];
    trialsByChunk.set(t.source_chunk_id, forChunk);
    forChunk.push({
      baselineModel: t.baseline_model,
      trialModel: t.trial_model,
      kind: t.kind,
      chunkSize: t.chunk_size,
      chunkOverlap: t.chunk_overlap,
      pieceCount: t.piece_count,
      k: t.k,
      pool: t.pool_chunk_ids,
      results,
    });
  }

  const byChunk = new Map<string, OverrideRow[]>();
  for (const o of overrides) {
    const forChunk = byChunk.get(o.source_chunk_id) ?? [];
    byChunk.set(o.source_chunk_id, forChunk);
    forChunk.push(o);
  }

  const entries: ReplayTuningEntry[] = [];
  for (const [chunk, rows] of byChunk) {
    // Dropped whole rather than partially: an override's pieces share one model,
    // so a foreign model is a foreign entry.
    if (!servableBy(rows[0].model, baseModel)) continue;
    entries.push({
      chunk,
      model: rows[0].model,
      kind: rows[0].kind as ReplayTuningEntry["kind"],
      detail: detailFor(rows[0], rows.length),
      pieces: rows.map((r) => ({
        text: r.text,
        dimension: r.dimension,
        embedding: packEmbedding(r.embedding),
        tokenStart: r.token_start,
        tokenEnd: r.token_end,
      })),
      trials: trialsByChunk.get(chunk) ?? [],
    });
  }
  return { version: 1, entries };
}
