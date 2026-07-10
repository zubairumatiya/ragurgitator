// ---------------------------------------------------------------------------
// One-shot (idempotent, re-runnable) backfill of embedding_cache (0020) from
// every vector the app has already paid for:
//
//   1. Each ingestable model's chunks_<model>_<dim> table — every config that
//      ever ingested banked (text, vector) pairs under its base model.
//   2. Override pieces with their own text (size / size+model re-splits).
//   3. Whole-chunk model overrides (text NULL = the source chunk's full text),
//      joined back to the owning config's base chunks table for the text.
//
// Everything runs server-side (insert … select with sha256() and the pgvector
// ::real[] cast); no vectors cross the wire. `on conflict do nothing` makes
// re-runs and duplicate texts free.
//
//   Usage: DATABASE_URL=… npx tsx scripts/backfill-embedding-cache.ts
// ---------------------------------------------------------------------------
import { sql } from "../lib/db";
import { EMBEDDING_MODELS } from "../lib/rag/embeddingModels";

// Mirrors vectorStore.chunksTable (not imported to keep this script off the
// "@/" alias chain tsx doesn't resolve here).
const chunksTable = (model: string, dimension: number) =>
  `chunks_${model.replace(/-/g, "_")}_${dimension}`;

async function tableExists(name: string): Promise<boolean> {
  const [row] = await sql<{ ok: string | null }[]>`
    select to_regclass(${name}) as ok
  `;
  return row.ok !== null;
}

async function main() {
  let total = 0;

  // 1. Base chunk tables, per ingestable model.
  for (const spec of Object.values(EMBEDDING_MODELS)) {
    if (!spec.ingestable) continue;
    const table = chunksTable(spec.id, spec.dimension);
    if (!(await tableExists(table))) {
      console.log(`- ${table}: does not exist, skipping`);
      continue;
    }
    const inserted = await sql`
      insert into embedding_cache (model, input_kind, text_hash, dimension, embedding)
      select ${spec.id}, 'document', encode(sha256(text::bytea), 'hex'),
             ${spec.dimension}, embedding::real[]
      from ${sql(table)}
      on conflict do nothing
      returning 1
    `;
    console.log(`- ${table}: +${inserted.length} cache row(s)`);
    total += inserted.length;
  }

  // 2. Override pieces that carry their own text (size / size+model).
  const pieces = await sql`
    insert into embedding_cache (model, input_kind, text_hash, dimension, embedding)
    select model, 'document', encode(sha256(text::bytea), 'hex'), dimension, embedding
    from config_chunk_overrides
    where text is not null
    on conflict do nothing
    returning 1
  `;
  console.log(`- override pieces (own text): +${pieces.length} cache row(s)`);
  total += pieces.length;

  // 3. Whole-chunk model overrides: text lives on the source chunk in the
  //    owning config's base table.
  const configs = await sql<{ id: string; base_model: string }[]>`
    select id, base_model from configs
  `;
  for (const cfg of configs) {
    const spec = EMBEDDING_MODELS[cfg.base_model];
    if (!spec) {
      console.log(`- config ${cfg.id}: unknown base model ${cfg.base_model}, skipping`);
      continue;
    }
    const table = chunksTable(spec.id, spec.dimension);
    if (!(await tableExists(table))) continue;
    const wholeChunk = await sql`
      insert into embedding_cache (model, input_kind, text_hash, dimension, embedding)
      select o.model, 'document', encode(sha256(c.text::bytea), 'hex'),
             o.dimension, o.embedding
      from config_chunk_overrides o
      join ${sql(table)} c on c.id = o.source_chunk_id
      where o.config_id = ${cfg.id} and o.text is null
      on conflict do nothing
      returning 1
    `;
    if (wholeChunk.length > 0) {
      console.log(`- config ${cfg.id} whole-chunk overrides: +${wholeChunk.length} cache row(s)`);
    }
    total += wholeChunk.length;
  }

  const [count] = await sql<{ n: string }[]>`select count(*) as n from embedding_cache`;
  console.log(`Done: +${total} new row(s); embedding_cache now holds ${count.n}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
