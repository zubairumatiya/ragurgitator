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
// OWNERSHIP (0050): embedding_cache is per-user, so every insert derives its
// user_id from the vector's own provenance rather than taking one. That is why
// this script needs no SCRIPT_USER_ID — each source row already reaches an owner
// (chunks_* → document_embeddings → configs.user_id; config_chunk_overrides →
// configs.user_id), and deriving is strictly better than an operator-supplied
// id, which would mis-attribute every row on a multi-tenant database.
//
//   Usage: DATABASE_URL=… npx tsx scripts/backfill-embedding-cache.ts
// ---------------------------------------------------------------------------
// privilegedSql, not sql: this script is deliberately cross-tenant — it derives
// each row's owner from the vector's own provenance rather than running as one
// user — so it is the third and last legitimate caller of the bypassing pool.
// The restricted handle would (correctly) return nothing here, since a script
// has no request scope and therefore no app.user_id for 0051's policies to read.
import { privilegedSql as sql } from "../lib/db";
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
    // distinct: one chunk text can appear under several configs of the same
    // owner, and the insert is now keyed per user — without it the statement
    // would try to write the same (user, model, kind, hash) row twice in one
    // command, which `on conflict do nothing` does NOT cover.
    const inserted = await sql`
      insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
      select distinct on (cf.user_id, encode(sha256(c.text::bytea), 'hex'))
             cf.user_id, ${spec.id}, 'document', encode(sha256(c.text::bytea), 'hex'),
             ${spec.dimension}, c.embedding::real[]
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      join configs cf on cf.id = de.config_id
      on conflict do nothing
      returning 1
    `;
    console.log(`- ${table}: +${inserted.length} cache row(s)`);
    total += inserted.length;
  }

  // 2. Override pieces that carry their own text (size / size+model).
  const pieces = await sql`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    select distinct on (cf.user_id, o.model, encode(sha256(o.text::bytea), 'hex'))
           cf.user_id, o.model, 'document', encode(sha256(o.text::bytea), 'hex'),
           o.dimension, o.embedding
    from config_chunk_overrides o
    join configs cf on cf.id = o.config_id
    where o.text is not null
    on conflict do nothing
    returning 1
  `;
  console.log(`- override pieces (own text): +${pieces.length} cache row(s)`);
  total += pieces.length;

  // 3. Whole-chunk model overrides: text lives on the source chunk in the
  //    owning config's base table.
  const configs = await sql<{ id: string; base_model: string; user_id: string }[]>`
    select id, base_model, user_id from configs
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
      insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
      select distinct on (o.model, encode(sha256(c.text::bytea), 'hex'))
             ${cfg.user_id}, o.model, 'document', encode(sha256(c.text::bytea), 'hex'),
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
