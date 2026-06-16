// ---------------------------------------------------------------------------
// CLUSTER STORE + ENGINE for the /clusters page.
//
// Reads the active-config corpus vectors, runs k-means (lib/rag/cluster.ts), and
// persists the buckets. A "run" produces several candidates (random restarts)
// the user can compare and keep; unsaved candidates are pruned when the next run
// starts. Mirrors the run/snapshot conventions in lib/rag/evalStore.ts.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { config } from "@/lib/config";
import { chunksTable, vectorLiteral } from "@/lib/rag/vectorStore";
import { computeCandidate, seedForRestart, type Candidate } from "@/lib/rag/cluster";

const RESTARTS = 3;
const CC_INSERT_BATCH = 2000; // chunk_clusters rows per insert (param-limit safety)

// One bucket in a run's detail view.
export type ClusterBucket = {
  id: string;
  ordinal: number;
  size: number;
  cohesion: number;
  label: string | null;
  // The chunk nearest this bucket's centroid — a cheap human hint until the
  // Claude-labeling follow-up exists. Null if the corpus changed under the run.
  representative: {
    chunkId: string;
    fileName: string;
    position: number | null;
    snippet: string;
  } | null;
};

// Headline for a run: enough for the candidate cards, the saved-presets list, and
// the compare modal (which uses sizes/cohesions as per-bucket profiles).
export type ClusterRunSummary = {
  id: string;
  k: number;
  saved: boolean;
  name: string | null;
  chunkCount: number;
  avgCohesion: number;
  silhouette: number;
  sizes: number[]; // by ordinal
  cohesions: number[]; // by ordinal
  createdAt: number;
};

export type ClusterRunDetail = ClusterRunSummary & { buckets: ClusterBucket[] };

export type BucketChunk = {
  chunkId: string;
  fileName: string;
  position: number | null;
  text: string;
  similarity: number;
};

// Streamed progress for a run (NDJSON, mirrors EvalEvent).
export type ClusterEvent =
  | { type: "load"; chunkCount: number }
  | {
      type: "restart";
      index: number;
      total: number;
      iterations: number;
      avgCohesion: number;
      silhouette: number;
    }
  | { type: "done"; runs: ClusterRunSummary[] }
  | { type: "error"; message: string };

type Emit = (event: ClusterEvent) => void;

// The chunks table for the active config, or null when nothing is ingested.
async function activeChunksTable(): Promise<string | null> {
  const rows = await sql<{ dimension: number }[]>`
    select dimension
    from document_embeddings
    where model = ${config.embeddingModel}
      and chunk_size = ${config.chunkSize}
      and chunk_overlap = ${config.chunkOverlap}
    limit 1
  `;
  if (rows.length === 0) return null;
  return chunksTable(config.embeddingModel, rows[0].dimension);
}

// pgvector's text form is "[a,b,c]"; strip the brackets and parse.
function parseVector(s: string): number[] {
  return s.slice(1, -1).split(",").map(Number);
}

export async function corpusSize(): Promise<number> {
  const table = await activeChunksTable();
  if (!table) return 0;
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
  `;
  return row?.n ?? 0;
}

// All vectors of the active-config corpus, parsed to number[].
export async function loadCorpusVectors(): Promise<{ id: string; vec: number[] }[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  const rows = await sql<{ id: string; embedding: string }[]>`
    select c.id, c.embedding::text as embedding
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
  `;
  return rows.map((r) => ({ id: r.id, vec: parseVector(r.embedding) }));
}

// Persist one candidate (run + its k clusters + chunk assignments) in a txn.
async function persistCandidate(
  ids: string[],
  cand: Candidate,
  opts: { saved: boolean; name: string | null },
): Promise<{ id: string; createdAt: number }> {
  const dimension = cand.centroids[0]?.length ?? 0;

  return await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string; created_at: Date }[]>`
      insert into cluster_runs
        (model, dimension, k, seed, chunk_count, inertia, avg_cohesion,
         silhouette, saved, name)
      values
        (${config.embeddingModel}, ${dimension}, ${cand.k}, ${cand.seed},
         ${ids.length}, ${cand.inertia}, ${cand.avgCohesion}, ${cand.silhouette},
         ${opts.saved}, ${opts.name})
      returning id, created_at
    `;

    const clusterRows = cand.centroids.map((centroid, ordinal) => ({
      cluster_run_id: run.id,
      ordinal,
      centroid: vectorLiteral(centroid),
      size: cand.sizes[ordinal],
      cohesion: cand.cohesion[ordinal],
    }));
    const inserted = await tx<{ id: string; ordinal: number }[]>`
      insert into clusters ${tx(clusterRows)}
      returning id, ordinal
    `;
    const clusterIdByOrdinal = new Map(inserted.map((r) => [r.ordinal, r.id]));

    const ccRows = ids.map((chunkId, i) => {
      const ordinal = cand.assignments[i];
      return {
        cluster_run_id: run.id,
        chunk_id: chunkId,
        cluster_id: clusterIdByOrdinal.get(ordinal)!,
        similarity: cand.assignmentSim[i],
      };
    });
    for (let start = 0; start < ccRows.length; start += CC_INSERT_BATCH) {
      await tx`insert into chunk_clusters ${tx(ccRows.slice(start, start + CC_INSERT_BATCH))}`;
    }

    return { id: run.id, createdAt: run.created_at.getTime() };
  });
}

// Drop transient (unsaved) candidates for the active model — called before a new
// run so only saved presets and the latest batch ever accumulate.
export async function deleteUnsavedRuns(): Promise<void> {
  await sql`
    delete from cluster_runs
    where saved = false and model = ${config.embeddingModel}
  `;
}

function summaryFromCandidate(
  runId: string,
  createdAt: number,
  chunkCount: number,
  cand: Candidate,
): ClusterRunSummary {
  return {
    id: runId,
    k: cand.k,
    saved: false,
    name: null,
    chunkCount,
    avgCohesion: cand.avgCohesion,
    silhouette: cand.silhouette,
    sizes: cand.sizes,
    cohesions: cand.cohesion,
    createdAt,
  };
}

// Engine: load the corpus, run RESTARTS candidates at k, persist them as unsaved,
// and stream progress. Returns the candidate summaries.
export async function runClustering(k: number, emit: Emit = () => {}): Promise<ClusterRunSummary[]> {
  const corpus = await loadCorpusVectors();
  emit({ type: "load", chunkCount: corpus.length });
  if (corpus.length < k) {
    throw new Error(`Need at least ${k} chunks to make ${k} buckets; corpus has ${corpus.length}.`);
  }

  await deleteUnsavedRuns();

  const ids = corpus.map((c) => c.id);
  const vectors = corpus.map((c) => c.vec);
  const baseSeed = Date.now() >>> 0;
  const summaries: ClusterRunSummary[] = [];

  for (let r = 0; r < RESTARTS; r++) {
    const cand = computeCandidate(vectors, k, seedForRestart(baseSeed, r));
    const { id, createdAt } = await persistCandidate(ids, cand, { saved: false, name: null });
    summaries.push(summaryFromCandidate(id, createdAt, corpus.length, cand));
    emit({
      type: "restart",
      index: r + 1,
      total: RESTARTS,
      iterations: cand.iterations,
      avgCohesion: cand.avgCohesion,
      silhouette: cand.silhouette,
    });
    // Yield so the NDJSON chunk flushes before the next (synchronous) restart.
    await new Promise((res) => setTimeout(res, 0));
  }

  emit({ type: "done", runs: summaries });
  return summaries;
}

// Per-run cluster rows (sizes + cohesions by ordinal), for building summaries.
async function bucketRowsByRun(
  runIds: string[],
): Promise<Map<string, { size: number; cohesion: number }[]>> {
  const byRun = new Map<string, { size: number; cohesion: number }[]>();
  if (runIds.length === 0) return byRun;
  const rows = await sql<
    { cluster_run_id: string; size: number; cohesion: number }[]
  >`
    select cluster_run_id, size, cohesion
    from clusters
    where cluster_run_id = any(${runIds}::uuid[])
    order by cluster_run_id, ordinal
  `;
  for (const r of rows) {
    const list = byRun.get(r.cluster_run_id) ?? [];
    list.push({ size: r.size, cohesion: r.cohesion });
    byRun.set(r.cluster_run_id, list);
  }
  return byRun;
}

// Saved presets + the current unsaved candidates, newest-relevant first.
export async function listRuns(): Promise<ClusterRunSummary[]> {
  const runs = await sql<
    {
      id: string;
      k: number;
      saved: boolean;
      name: string | null;
      chunk_count: number;
      avg_cohesion: number;
      silhouette: number;
      created_at: Date;
    }[]
  >`
    select id, k, saved, name, chunk_count, avg_cohesion, silhouette, created_at
    from cluster_runs
    where model = ${config.embeddingModel}
    order by saved desc, created_at desc
  `;

  const buckets = await bucketRowsByRun(runs.map((r) => r.id));
  return runs.map((r) => {
    const list = buckets.get(r.id) ?? [];
    return {
      id: r.id,
      k: r.k,
      saved: r.saved,
      name: r.name,
      chunkCount: r.chunk_count,
      avgCohesion: r.avg_cohesion,
      silhouette: r.silhouette,
      sizes: list.map((b) => b.size),
      cohesions: list.map((b) => b.cohesion),
      createdAt: r.created_at.getTime(),
    };
  });
}

// Full run detail: each bucket plus its nearest-to-centroid representative chunk.
export async function getRun(id: string): Promise<ClusterRunDetail | null> {
  const [run] = await sql<
    {
      id: string;
      k: number;
      saved: boolean;
      name: string | null;
      chunk_count: number;
      avg_cohesion: number;
      silhouette: number;
      created_at: Date;
    }[]
  >`
    select id, k, saved, name, chunk_count, avg_cohesion, silhouette, created_at
    from cluster_runs
    where id = ${id} and model = ${config.embeddingModel}
  `;
  if (!run) return null;

  const clusterRows = await sql<
    { id: string; ordinal: number; size: number; cohesion: number; label: string | null }[]
  >`
    select id, ordinal, size, cohesion, label
    from clusters
    where cluster_run_id = ${id}
    order by ordinal
  `;

  // One representative (nearest-to-centroid) chunk per bucket.
  const table = await activeChunksTable();
  const reps = table
    ? await sql<
        {
          cluster_id: string;
          chunk_id: string;
          position: number | null;
          snippet: string;
          file_name: string;
        }[]
      >`
        select distinct on (cc.cluster_id)
          cc.cluster_id, c.id as chunk_id, c.position,
          left(c.text, 160) as snippet, d.file_name
        from chunk_clusters cc
        join ${sql(table)} c on c.id = cc.chunk_id
        join documents d on d.id = c.document_id
        where cc.cluster_run_id = ${id}
        order by cc.cluster_id, cc.similarity desc
      `
    : [];
  const repByCluster = new Map(reps.map((r) => [r.cluster_id, r]));

  const buckets: ClusterBucket[] = clusterRows.map((c) => {
    const rep = repByCluster.get(c.id);
    return {
      id: c.id,
      ordinal: c.ordinal,
      size: c.size,
      cohesion: c.cohesion,
      label: c.label,
      representative: rep
        ? {
            chunkId: rep.chunk_id,
            fileName: rep.file_name,
            position: rep.position,
            snippet: rep.snippet,
          }
        : null,
    };
  });

  return {
    id: run.id,
    k: run.k,
    saved: run.saved,
    name: run.name,
    chunkCount: run.chunk_count,
    avgCohesion: run.avg_cohesion,
    silhouette: run.silhouette,
    sizes: buckets.map((b) => b.size),
    cohesions: buckets.map((b) => b.cohesion),
    createdAt: run.created_at.getTime(),
    buckets,
  };
}

// All chunks in a bucket, nearest-to-centroid first (the indexed bucket lookup).
export async function getBucketChunks(clusterId: string): Promise<BucketChunk[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  const rows = await sql<
    {
      id: string;
      position: number | null;
      text: string;
      file_name: string;
      similarity: number;
    }[]
  >`
    select c.id, c.position, c.text, d.file_name, cc.similarity
    from chunk_clusters cc
    join ${sql(table)} c on c.id = cc.chunk_id
    join documents d on d.id = c.document_id
    where cc.cluster_id = ${clusterId}
    order by cc.similarity desc
  `;
  return rows.map((r) => ({
    chunkId: r.id,
    fileName: r.file_name,
    position: r.position,
    text: r.text,
    similarity: r.similarity,
  }));
}

// Keep a candidate as a named preset.
export async function saveRun(id: string, name: string): Promise<boolean> {
  const rows = await sql`
    update cluster_runs set saved = true, name = ${name}
    where id = ${id} and model = ${config.embeddingModel}
    returning id
  `;
  return rows.length > 0;
}

export async function deleteRun(id: string): Promise<boolean> {
  const rows = await sql`delete from cluster_runs where id = ${id} returning id`;
  return rows.length > 0;
}
