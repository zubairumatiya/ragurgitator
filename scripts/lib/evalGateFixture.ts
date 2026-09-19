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
import { createHash } from "node:crypto";

// [offset, length] into vectors.f32, both counted in FLOATS, not bytes.
export type VecRef = [offset: number, length: number];

// Chunk ids are minted fresh on every load, so nothing id-shaped travels: a
// chunk is `<file_name>#<position>` and the loader maps keys to the ids it gets
// back (the same rule as lib/demo/clone.ts steps 4b/4c).
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

// Append-only builder for vectors.f32.
export class VectorBlob {
  private parts: Float32Array[] = [];
  private floats = 0;

  add(vec: Float32Array): VecRef {
    const ref: VecRef = [this.floats, vec.length];
    this.parts.push(vec);
    this.floats += vec.length;
    return ref;
  }

  get length(): number {
    return this.floats;
  }

  // Little-endian on disk whatever the host is: a Float32Array's own buffer is
  // host-endian, and a fixture written on one machine is read on another.
  toBuffer(): Buffer {
    const out = Buffer.allocUnsafe(this.floats * 4);
    let at = 0;
    for (const p of this.parts) {
      for (let i = 0; i < p.length; i++, at += 4) out.writeFloatLE(p[i], at);
    }
    return out;
  }
}

export function readVec(blob: Buffer, [offset, length]: VecRef): Float32Array {
  if (offset < 0 || length <= 0 || (offset + length) * 4 > blob.length) {
    throw new Error(`vector [${offset}, ${length}] is outside the blob (${blob.length / 4} floats)`);
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = blob.readFloatLE((offset + i) * 4);
  return out;
}

// pgvector's binary send format: int16 dim, int16 unused, then dim float4s, all
// big-endian. `export` reads vectors as base64 of this rather than as text —
// ~17 MB on the wire instead of ~40 MB — and it is exact by construction, where
// a text round trip is only exact because float4 prints shortest-round-trip.
export function decodeVectorSend(base64: string): Float32Array {
  const buf = Buffer.from(base64, "base64");
  const dim = buf.readUInt16BE(0);
  if (buf.length !== 4 + dim * 4) {
    throw new Error(`vector_send payload is ${buf.length} bytes, expected ${4 + dim * 4} for dim ${dim}`);
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatBE(4 + i * 4);
  return out;
}

// The fixture's identity: sha256 over the manifest and the blob. baseline.json
// records it, and the gate refuses a baseline taken over a different fixture.
//
// `exportedAt` is left out along with the hash itself: a re-export of unchanged
// data would otherwise mint a new identity and invalidate a baseline that is
// still exactly right.
export function fixtureHash(manifest: Manifest, blob: Buffer): string {
  const identity: Partial<Manifest> = { ...manifest };
  delete identity.fixtureHash;
  delete identity.exportedAt;
  return createHash("sha256").update(JSON.stringify(identity)).update(blob).digest("hex");
}

// Every way the file can point at something that is not there. Returns ALL the
// problems rather than throwing on the first: a broken export usually has one
// cause and many symptoms, and the list is what shows the cause.
export function manifestProblems(m: Manifest, blobFloats: number): string[] {
  const problems: string[] = [];
  const vec = (where: string, ref: VecRef, dim?: number) => {
    const [offset, length] = ref;
    if (offset < 0 || length <= 0 || offset + length > blobFloats) {
      problems.push(`${where}: vector [${offset}, ${length}] is outside the blob`);
    } else if (dim !== undefined && length !== dim) {
      problems.push(`${where}: vector is ${length} wide, expected ${dim}`);
    }
  };

  const docs = new Set(m.documents.map((d) => d.fileName));
  if (docs.size !== m.documents.length) problems.push("documents: duplicate file_name");

  const chunks = new Set<string>();
  for (const c of m.chunks) {
    if (chunks.has(c.key)) problems.push(`chunk ${c.key}: duplicate key`);
    chunks.add(c.key);
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

// One record per line. A fixture refresh is a reviewed PR diff (decision 6), and
// an indent-2 dump of 3,000 `[offset, length]` pairs spends four lines on each.
export function serializeManifest(m: Manifest): string {
  const lines = (rows: unknown[]) =>
    rows.length === 0 ? "[]" : `[\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]`;
  const fields = Object.entries(m).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${Array.isArray(v) && typeof v[0] === "object" ? lines(v) : JSON.stringify(v)}`,
  );
  return `{\n${fields.join(",\n")}\n}\n`;
}
