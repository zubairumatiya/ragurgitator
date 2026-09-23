// The pure half of the CI eval gate's fixture (docs/ci-eval-gate-plan.md §1):
// the manifest's shape, the vector blob, the fixture's identity hash, and the
// checks that refuse a fixture with a hole in it. No DB and no lib/ import, so
// `export` (live → files) and `load` (files → the CI database) read and write
// one format, and that format is testable on its own.
//
// A PARTIAL FIXTURE IS WORSE THAN NONE. The retriever treats a missing vector as
// a cache miss and carries on with the lane dark, so a fixture that lost one
// would still produce numbers — for a retrieval path production never runs.
// Every reference is therefore checked on BOTH sides of the file.
import { hashFixture, vecProblem, type VecRef } from "./fixtureBlob";

// The blob, its references and the serialization are shared with the cache
// gate; they live in fixtureBlob.ts and are re-exported so `export`, `load` and
// the tests keep one import.
export { VectorBlob, decodeVectorSend, readVec, serializeManifest, type VecRef } from "./fixtureBlob";

// Everything in the file REFERS to a chunk by `<file_name>#<position>`: readable
// in a diff and in a red run's movers table, where a uuid is neither.
export const chunkKey = (fileName: string, position: number): string =>
  `${fileName}#${position}`;

export type FixtureConfig = {
  baseModel: string;
  dimension: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  // null = the retriever's own default, which is what production runs today.
  fusionPool: number | null;
  // null = top_k, as in the product (evalSettingsStore.effectiveK).
  recallK: number | null;
  mrrK: number | null;
  ndcgK: number | null;
};

export type FixtureDocument = { fileName: string; contentHash: string; content: string };

export type FixtureChunk = {
  key: string;
  // The master's own chunk id, and the loader inserts it verbatim. It has to
  // travel: fused ranks TIE (two lanes can both place a chunk at rank 3.5), the
  // merge breaks a tie by lane order, and lane order falls out of an unordered
  // `select distinct source_chunk_id, …` — so it follows the ids. Minting fresh
  // ids per load moved 40+ retrieved lists between two loads of the same files.
  id: string;
  document: string;
  position: number;
  text: string;
  vec: VecRef;
};

export type FixtureOverride = {
  chunk: string;
  pieceIndex: number;
  model: string;
  dimension: number;
  kind: string;
  // null on a whole-chunk 'model' override: the piece IS the chunk.
  text: string | null;
  tokenStart: number | null;
  tokenEnd: number | null;
  vec: VecRef;
};

export type FixturePoolDoc = { model: string; chunk: string; vec: VecRef };

export type FixtureQuestion = {
  question: string;
  difficulty: string | null;
  expectedAnswer: string | null;
  source: string;
  // The is_truth ideal ranking as chunk keys, best first.
  truth: string[];
  qvec: Record<string, VecRef>;
};

export type FixtureSplit = {
  mode: "pct";
  size: number;
  seed: number;
  candidates: number;
  // holdoutSplitKey over the master's question UUIDs — the ids do not travel,
  // but a re-export from a changed question bank is visibly a different split.
  splitKey: string;
};

export type Manifest = {
  version: 1;
  exportedAt: string;
  sourceConfigId: string;
  fixtureHash: string;
  config: FixtureConfig;
  // The override models that open their own fusion lane. Derived from
  // `overrides`, but stated, so the loader and the "every lane fired" assertion
  // do not each re-decide what counts as foreign.
  foreignModels: string[];
  split: FixtureSplit;
  documents: FixtureDocument[];
  chunks: FixtureChunk[];
  overrides: FixtureOverride[];
  poolDocs: FixturePoolDoc[];
  questions: FixtureQuestion[];
};

// The fixture's identity: sha256 over the manifest and the blob. baseline.json
// records it, and the gate refuses a baseline taken over a different fixture.
//
// `exportedAt` is left out along with the hash itself: a re-export of unchanged
// data would otherwise mint a new identity and invalidate a baseline that is
// still exactly right.
export const fixtureHash = (manifest: Manifest, blob: Buffer): string => hashFixture(manifest, blob);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every way the file can point at something that is not there. Returns ALL the
// problems rather than throwing on the first: a broken export usually has one
// cause and many symptoms, and the list is what shows the cause.
export function manifestProblems(m: Manifest, blobFloats: number): string[] {
  const problems: string[] = [];
  const vec = (where: string, ref: VecRef, dim?: number) => {
    const problem = vecProblem(where, ref, blobFloats, dim);
    if (problem) problems.push(problem);
  };

  const docs = new Set(m.documents.map((d) => d.fileName));
  if (docs.size !== m.documents.length) problems.push("documents: duplicate file_name");

  const chunks = new Set<string>();
  const ids = new Set<string>();
  for (const c of m.chunks) {
    if (chunks.has(c.key)) problems.push(`chunk ${c.key}: duplicate key`);
    chunks.add(c.key);
    if (!UUID.test(c.id)) problems.push(`chunk ${c.key}: id is not a uuid`);
    if (ids.has(c.id)) problems.push(`chunk ${c.key}: duplicate id`);
    ids.add(c.id);
    if (c.key !== chunkKey(c.document, c.position)) problems.push(`chunk ${c.key}: key does not match document#position`);
    if (!docs.has(c.document)) problems.push(`chunk ${c.key}: unknown document ${c.document}`);
    vec(`chunk ${c.key}`, c.vec, m.config.dimension);
  }

  const overrideModels = new Set<string>();
  for (const o of m.overrides) {
    const where = `override ${o.chunk}/${o.model}/${o.pieceIndex}`;
    if (!chunks.has(o.chunk)) problems.push(`${where}: unknown chunk`);
    vec(where, o.vec, o.dimension);
    overrideModels.add(o.model);
  }
  for (const model of m.foreignModels) {
    if (!overrideModels.has(model)) problems.push(`foreign model ${model}: no override names it`);
  }

  // Every foreign lane needs the WHOLE pool: which chunks a question pools is
  // decided at run time, so any chunk can be asked for under any foreign model.
  const pooled = new Set<string>();
  for (const p of m.poolDocs) {
    const where = `poolDoc ${p.model}/${p.chunk}`;
    if (!chunks.has(p.chunk)) problems.push(`${where}: unknown chunk`);
    if (!m.foreignModels.includes(p.model)) problems.push(`${where}: not a foreign model`);
    if (pooled.has(where)) problems.push(`${where}: duplicate`);
    pooled.add(where);
    vec(where, p.vec);
  }
  for (const model of m.foreignModels) {
    for (const key of chunks) {
      if (!pooled.has(`poolDoc ${model}/${key}`)) problems.push(`poolDoc ${model}/${key}: missing`);
    }
  }

  const lanes = [m.config.baseModel, ...m.foreignModels];
  for (const q of m.questions) {
    const where = `question "${q.question.slice(0, 50)}"`;
    if (!chunks.has(q.source)) problems.push(`${where}: unknown source chunk ${q.source}`);
    if (q.truth.length === 0) problems.push(`${where}: no truth ranking`);
    for (const key of q.truth) {
      if (!chunks.has(key)) problems.push(`${where}: truth names unknown chunk ${key}`);
    }
    for (const model of lanes) {
      const ref = q.qvec[model];
      if (!ref) problems.push(`${where}: no query vector under ${model}`);
      else vec(`${where} under ${model}`, ref, model === m.config.baseModel ? m.config.dimension : undefined);
    }
  }

  return problems;
}
