// ---------------------------------------------------------------------------
// CLUSTER STORE + ENGINE for the /clusters page.
//
// Reads the active-config corpus vectors, runs k-means (lib/rag/cluster.ts), and
// persists the buckets. A "run" produces several candidates (random restarts)
// the user can compare and keep; unsaved candidates are pruned when the next run
// starts. Mirrors the run/snapshot conventions in lib/rag/evalStore.ts.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { vectorLiteral } from "@/lib/rag/vectorStore";
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
  // Active-config documents with NO chunk in this run — documents ingested
  // after it was built. A run that misses a document gives that document's
  // questions candidate pools drawn from the wrong documents, so the eval UI
  // flags (and the bulk nDCG grader skips) them. Top-up keeps this empty going
  // forward; it stays populated for docs that predate migration 0033 and for
  // every doc after a re-chunk (which top-up deliberately sits out).
  missingDocuments: { id: string; fileName: string }[];
  // Members assigned to a frozen centroid AFTER the fit (migration 0033), and
  // their share of current membership. chunkCount describes the fit and never
  // moves, so driftRatio is the gap between "what was fit" and "what's in the
  // buckets now" — past config.clusterDriftThreshold the UI says re-fit.
  toppedUpCount: number;
  driftRatio: number;
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
  const cfg = activeConfig();
  const rows = await sql`
    select 1 from document_embeddings where config_id = ${cfg.id} limit 1
  `;
  return rows.length > 0 ? cfg.chunksTable : null;
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
    where de.config_id = ${activeConfig().id}
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
    where de.config_id = ${activeConfig().id}
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
    const cfg = activeConfig();
    const [run] = await tx<{ id: string; created_at: Date }[]>`
      insert into cluster_runs
        (config_id, model, dimension, k, seed, chunk_count, inertia, avg_cohesion,
         silhouette, saved, name)
      values
        (${cfg.id}, ${cfg.embeddingModel}, ${dimension}, ${cand.k}, ${cand.seed},
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
    where saved = false and config_id = ${activeConfig().id}
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
    // A fresh run clusters the entire active corpus, so nothing is missing and
    // every member came from the fit itself.
    missingDocuments: [],
    toppedUpCount: 0,
    driftRatio: 0,
  };
}

// --- Incremental top-up (migration 0033) -----------------------------------
// Assign freshly ingested chunks to their nearest EXISTING centroid in every
// saved preset of the active config, so their questions become gradeable on
// /eval right away instead of being skipped until someone re-runs clustering.
//
// Deliberately NOT called when re-chunking a config in place (lib/rag/
// reconfigure.ts): that mints new ids for the WHOLE corpus, so topping up would
// paper over a preset whose centroids describe a chunking that no longer
// exists. Leaving those runs untouched lets the existing missing-documents flag
// fire on every document, which is the honest signal to re-fit.
//
// Idempotent: the (cluster_run_id, chunk_id) primary key makes a repeat call a
// no-op, so a retried ingest can't double-count drift.
export async function topUpSavedRuns(chunkIds: string[]): Promise<number> {
  if (chunkIds.length === 0) return 0;
  const cfg = activeConfig();

  // Model + dimension must match, not just config: a config whose model changed
  // keeps its older runs, and their centroids live in a different vector space
  // (and pgvector would reject the dimension outright).
  const runs = await sql<{ id: string }[]>`
    select id from cluster_runs
    where config_id = ${cfg.id}
      and saved = true
      and model = ${cfg.embeddingModel}
      and dimension = ${cfg.dimension}
  `;
  if (runs.length === 0) return 0;

  let assigned = 0;
  for (const run of runs) {
    for (let start = 0; start < chunkIds.length; start += CC_INSERT_BATCH) {
      const batch = chunkIds.slice(start, start + CC_INSERT_BATCH);
      // One nearest-centroid lookup per chunk. `<=>` is cosine distance here, so
      // 1 - distance matches the cosine similarity the k-means fit stored.
      const rows = await sql<{ chunk_id: string }[]>`
        insert into chunk_clusters (cluster_run_id, chunk_id, cluster_id, similarity, topped_up_at)
        select ${run.id}, c.id, nearest.id, 1 - nearest.distance, now()
        from ${sql(cfg.chunksTable)} c
        cross join lateral (
          select cl.id, cl.centroid <=> c.embedding as distance
          from clusters cl
          where cl.cluster_run_id = ${run.id}
          order by cl.centroid <=> c.embedding
          limit 1
        ) nearest
        where c.id = any(${batch}::uuid[])
        on conflict (cluster_run_id, chunk_id) do nothing
        returning chunk_id
      `;
      assigned += rows.length;
    }
  }

  if (assigned > 0) {
    console.log(
      `[rag:clusters] topped up ${assigned} chunk assignment(s) across ` +
        `${runs.length} saved preset(s) for config=${cfg.id.slice(0, 8)}`,
    );
  }
  return assigned;
}

// Per-run count of members that arrived by top-up rather than by the fit. The
// numerator of driftRatio; see migration 0033.
async function toppedUpByRun(runIds: string[]): Promise<Map<string, number>> {
  const byRun = new Map<string, number>();
  if (runIds.length === 0) return byRun;
  const rows = await sql<{ cluster_run_id: string; n: number }[]>`
    select cluster_run_id, count(*)::int as n
    from chunk_clusters
    where cluster_run_id = any(${runIds}::uuid[])
      and topped_up_at is not null
    group by cluster_run_id
  `;
  for (const r of rows) byRun.set(r.cluster_run_id, r.n);
  return byRun;
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

// Per-run document-coverage gaps: for each given run, the active-config
// documents that have no chunk in any of its buckets (ingested after the run
// was built). Empty array = full coverage.
export async function missingDocumentsByRun(
  runIds: string[],
): Promise<Map<string, { id: string; fileName: string }[]>> {
  const byRun = new Map<string, { id: string; fileName: string }[]>();
  if (runIds.length === 0) return byRun;
  const table = await activeChunksTable();
  if (!table) return new Map(runIds.map((id) => [id, []]));

  const [docs, covered] = await Promise.all([
    sql<{ id: string; file_name: string }[]>`
      select distinct d.id, d.file_name
      from ${sql(table)} c
      join documents d on d.id = c.document_id
      join document_embeddings de on de.id = c.document_embedding_id
      where de.config_id = ${activeConfig().id}
    `,
    sql<{ cluster_run_id: string; document_id: string }[]>`
      select distinct cc.cluster_run_id, c.document_id
      from chunk_clusters cc
      join ${sql(table)} c on c.id = cc.chunk_id
      where cc.cluster_run_id = any(${runIds}::uuid[])
    `,
  ]);

  const coveredByRun = new Map<string, Set<string>>();
  for (const r of covered) {
    const set = coveredByRun.get(r.cluster_run_id) ?? new Set<string>();
    set.add(r.document_id);
    coveredByRun.set(r.cluster_run_id, set);
  }
  for (const runId of runIds) {
    const set = coveredByRun.get(runId) ?? new Set<string>();
    byRun.set(
      runId,
      docs
        .filter((d) => !set.has(d.id))
        .map((d) => ({ id: d.id, fileName: d.file_name })),
    );
  }
  return byRun;
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
    where config_id = ${activeConfig().id}
    order by saved desc, created_at desc
  `;

  const runIds = runs.map((r) => r.id);
  const [buckets, missing, toppedUp] = await Promise.all([
    bucketRowsByRun(runIds),
    missingDocumentsByRun(runIds),
    toppedUpByRun(runIds),
  ]);
  return runs.map((r) => {
    const list = buckets.get(r.id) ?? [];
    const toppedUpCount = toppedUp.get(r.id) ?? 0;
    const current = r.chunk_count + toppedUpCount;
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
      missingDocuments: missing.get(r.id) ?? [],
      toppedUpCount,
      driftRatio: current > 0 ? toppedUpCount / current : 0,
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
    where id = ${id} and config_id = ${activeConfig().id}
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

  const [missing, toppedUp] = await Promise.all([
    missingDocumentsByRun([run.id]),
    toppedUpByRun([run.id]),
  ]);
  const toppedUpCount = toppedUp.get(run.id) ?? 0;
  const current = run.chunk_count + toppedUpCount;
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
    missingDocuments: missing.get(run.id) ?? [],
    toppedUpCount,
    driftRatio: current > 0 ? toppedUpCount / current : 0,
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

// Representative (nearest-to-centroid) chunks per bucket, for LLM labeling. We
// pass FULL chunk text, never a head-truncation: the embedding that placed a
// chunk in its bucket is computed over the whole chunk, so cutting off the tail
// would hide exactly what made it representative. Chunks are already token-
// bounded by the chunker, so the only size lever is COUNT — we scale chunks-per-
// bucket down as k grows (floor of 2 to keep some breadth) so the labeling
// prompt stays bounded without ever slicing into a chunk's meaning. One window-
// function query rather than k bucket lookups.
export async function representativeChunksForRun(
  runId: string,
): Promise<{ ordinal: number; chunks: string[] }[]> {
  const table = await activeChunksTable();
  if (!table) return [];

  const [counts] = await sql<{ k: number }[]>`
    select count(*)::int as k from clusters where cluster_run_id = ${runId}
  `;
  const k = counts?.k ?? 0;
  if (k === 0) return [];

  const rows = await sql<{ ordinal: number; text: string }[]>`
    select ordinal, text
    from (
      select cl.ordinal,
             c.text,
             row_number() over (partition by cc.cluster_id order by cc.similarity desc) as rn
      from chunk_clusters cc
      join clusters cl on cl.id = cc.cluster_id
      join ${sql(table)} c on c.id = cc.chunk_id
      where cc.cluster_run_id = ${runId}
    ) t
    where rn <= ${chunksPerBucket(k)}
    order by ordinal, rn
  `;
  const byOrdinal = new Map<number, string[]>();
  for (const r of rows) {
    const list = byOrdinal.get(r.ordinal) ?? [];
    list.push(r.text);
    byOrdinal.set(r.ordinal, list);
  }
  return [...byOrdinal.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ordinal, chunks]) => ({ ordinal, chunks }));
}

// Full chunks, so bound the labeling prompt by count, not by truncation:
// ~TARGET_TOKENS / (k buckets × avg chunk tokens), clamped to [2, 5]. Normal k
// gets 5 full chunks; large k trades breadth down to a floor of 2.
function chunksPerBucket(k: number): number {
  const TARGET_TOKENS = 50_000;
  const est = Math.round(TARGET_TOKENS / (k * activeConfig().chunkSize));
  return Math.max(2, Math.min(5, est));
}

// Persist Claude-generated bucket labels (by ordinal) for a run.
export async function saveClusterLabels(
  runId: string,
  labels: { ordinal: number; label: string }[],
): Promise<void> {
  if (labels.length === 0) return;
  await sql.begin(async (tx) => {
    for (const { ordinal, label } of labels) {
      await tx`
        update clusters set label = ${label}
        where cluster_run_id = ${runId} and ordinal = ${ordinal}
      `;
    }
  });
}

// Keep a candidate as a named preset.
export async function saveRun(id: string, name: string): Promise<boolean> {
  const rows = await sql`
    update cluster_runs set saved = true, name = ${name}
    where id = ${id} and config_id = ${activeConfig().id}
    returning id
  `;
  return rows.length > 0;
}

export async function deleteRun(id: string): Promise<boolean> {
  const rows = await sql`delete from cluster_runs where id = ${id} returning id`;
  return rows.length > 0;
}
