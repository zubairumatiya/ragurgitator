// ---------------------------------------------------------------------------
// DB layer for configs — one saved experiment = one top-level tab (see
// migrations/0011 and docs/multi-config-plan.md §4). Raw SQL via the shared
// `sql` client, no business logic; mirrors corpusStore.ts / evalStore.ts.
//
// A config points at one corpus and bundles the processing settings; all derived
// data (embedding runs, chunks, eval/cluster runs) is owned via config_id, so two
// configs over the same corpus with different settings are a clean A/B. This
// module powers the tab bar: list/create/rename/close/reopen/reorder/delete, plus
// the copy-on-write "duplicate" (D8/§4.4) that clones a config's vectors with NO
// embedding API calls because identical settings produce byte-identical vectors.
//
// Unlike the other stores, these functions take explicit ids (the config being
// acted on is named by the caller / URL) rather than reading activeConfig().
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { config } from "@/lib/config";
import { isUuid } from "@/lib/rag/activeConfig";
import { createCorpus } from "@/lib/rag/corpusStore";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

// Everything the tab bar / banner needs for one config. `label` is the display
// name: the user's `name`, or a default derived from settings when unnamed.
export type ConfigSummary = {
  id: string;
  name: string | null;
  label: string; // name ?? "<model> · <size>/<overlap>"
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  llmModel: string;
  corpusId: string;
  corpusName: string;
  isOpen: boolean;
  tabOrder: number;
  createdAt: number;
};

type ConfigJoinRow = {
  id: string;
  name: string | null;
  base_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  llm_model: string;
  corpus_id: string;
  corpus_name: string;
  is_open: boolean;
  tab_order: number;
  created_at: Date;
};

// The default label shown when a config is unnamed — short enough for a tab.
// The reopen menu enriches this with the corpus name + date itself.
function defaultLabel(baseModel: string, chunkSize: number, chunkOverlap: number): string {
  return `${baseModel} · ${chunkSize}/${chunkOverlap}`;
}

function toSummary(row: ConfigJoinRow): ConfigSummary {
  return {
    id: row.id,
    name: row.name,
    label: row.name ?? defaultLabel(row.base_model, row.chunk_size, row.chunk_overlap),
    baseModel: row.base_model,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    topK: row.top_k,
    llmModel: row.llm_model,
    corpusId: row.corpus_id,
    corpusName: row.corpus_name,
    isOpen: row.is_open,
    tabOrder: row.tab_order,
    createdAt: row.created_at.getTime(),
  };
}

// Open tabs, left-to-right. This is the tab bar's source of truth.
export async function listConfigs(): Promise<ConfigSummary[]> {
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.is_open, c.tab_order,
           c.created_at
    from configs c
    join corpora co on co.id = c.corpus_id
    where c.is_open = true
    order by c.tab_order, c.created_at
  `;
  return rows.map(toSummary);
}

// Closed/saved configs for the "reopen" menu (newest first — most likely wanted).
export async function listClosedConfigs(): Promise<ConfigSummary[]> {
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.is_open, c.tab_order,
           c.created_at
    from configs c
    join corpora co on co.id = c.corpus_id
    where c.is_open = false
    order by c.created_at desc
  `;
  return rows.map(toSummary);
}

export async function getConfig(id: string): Promise<ConfigSummary | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.is_open, c.tab_order,
           c.created_at
    from configs c
    join corpora co on co.id = c.corpus_id
    where c.id = ${id}
    limit 1
  `;
  return rows.length > 0 ? toSummary(rows[0]) : null;
}

// Count of currently-open tabs — used to refuse closing/deleting the last one
// (the UI always needs at least one tab to land on).
export async function countOpenConfigs(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from configs where is_open = true
  `;
  return rows[0].n;
}

export async function countConfigs(): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from configs`;
  return rows[0].n;
}

// The tab_order to place a newly-opened tab at: after every existing one.
async function nextTabOrder(): Promise<number> {
  const rows = await sql<{ next: number }[]>`
    select coalesce(max(tab_order), -1) + 1 as next from configs
  `;
  return rows[0].next;
}

export type NewConfigInput = {
  corpusId: string;
  name?: string | null;
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  llmModel: string;
};

// Insert a config row over an existing corpus, opened at the end of the tab bar.
// Low-level: the caller supplies the corpus and settings. (createEmptyConfig and
// duplicateConfig build on this for the two real entry points.)
export async function createConfig(input: NewConfigInput): Promise<ConfigSummary> {
  const tabOrder = await nextTabOrder();
  const rows = await sql<{ id: string }[]>`
    insert into configs
      (corpus_id, name, base_model, chunk_size, chunk_overlap, top_k, llm_model,
       is_open, tab_order)
    values
      (${input.corpusId}, ${input.name ?? null}, ${input.baseModel}, ${input.chunkSize},
       ${input.chunkOverlap}, ${input.topK}, ${input.llmModel}, true, ${tabOrder})
    returning id
  `;
  const created = await getConfig(rows[0].id);
  if (!created) throw new Error("Config vanished immediately after insert.");
  return created;
}

// The "+ New" tab: a brand-new EMPTY corpus + a config seeded with the
// lib/config.ts defaults. Starts with no documents — the user ingests into it
// (ingestion targeting is Phase 3). `name` defaults to null so it renders the
// settings-based label until renamed.
export async function createEmptyConfig(name?: string | null): Promise<ConfigSummary> {
  const corpusId = await createCorpus(name?.trim() || "New corpus");
  return createConfig({
    corpusId,
    name: name?.trim() || null,
    baseModel: config.embeddingModel,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    topK: config.topK,
    llmModel: config.llmModel,
  });
}

export async function renameConfig(id: string, name: string): Promise<ConfigSummary | null> {
  const trimmed = name.trim();
  const rows = await sql`
    update configs
    set name = ${trimmed || null}, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0 ? getConfig(id) : null;
}

// Close a tab (keep the config + its data; it can be reopened). Returns false
// when no row matched.
export async function closeConfig(id: string): Promise<boolean> {
  const rows = await sql`
    update configs set is_open = false, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0;
}

// Reopen a saved config, placing it at the end of the current tab bar.
export async function reopenConfig(id: string): Promise<boolean> {
  const tabOrder = await nextTabOrder();
  const rows = await sql`
    update configs set is_open = true, tab_order = ${tabOrder}, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0;
}

// Move a tab to a new left-to-right position. The UI sends the absolute order it
// wants for one config; neighbors keep their values (ties break by created_at in
// listConfigs), which is enough for the simple "send to position" MVP.
export async function setTabOrder(id: string, tabOrder: number): Promise<boolean> {
  const rows = await sql`
    update configs set tab_order = ${tabOrder}, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0;
}

// Permanently delete a config and everything it owns. ON DELETE CASCADE on
// config_id (document_embeddings → chunks, eval_runs, cluster_runs — see 0011)
// clears the derived data; the shared corpus + documents are left intact (D9).
// Returns false when no row matched.
export async function deleteConfig(id: string): Promise<boolean> {
  const rows = await sql`
    delete from configs where id = ${id} returning id
  `;
  return rows.length > 0;
}

// Duplicate a config via copy-on-write (D8/§4.4). The copy has identical settings
// over the SAME corpus, so its vectors are byte-identical — we INSERT…SELECT the
// source's document_embeddings + chunk rows under the new config_id instead of
// re-embedding (NO embedding API calls). corpus_documents membership is keyed by
// (corpus_id, document_id), so sharing the corpus means the copy inherits
// membership automatically — nothing to copy. Eval/cluster/ranking data is NOT
// copied: a duplicate starts with fresh eval history. Done in one transaction.
export async function duplicateConfig(id: string): Promise<ConfigSummary | null> {
  const source = await getConfig(id);
  if (!source) return null;

  // The source's physical chunk table (= the copy's, identical settings). Derive
  // it from the source row rather than the ambient default config.
  const dimension = modelDimension(source.baseModel);
  const table = chunksTable(source.baseModel, dimension);
  const copyName = `${source.name ?? source.label} copy`;
  const tabOrder = await nextTabOrder();

  const newId = await sql.begin(async (tx) => {
    const [created] = await tx<{ id: string }[]>`
      insert into configs
        (corpus_id, name, base_model, chunk_size, chunk_overlap, top_k, llm_model,
         is_open, tab_order)
      values
        (${source.corpusId}, ${copyName}, ${source.baseModel}, ${source.chunkSize},
         ${source.chunkOverlap}, ${source.topK}, ${source.llmModel}, true, ${tabOrder})
      returning id
    `;

    // Clone the embedding runs under the new config_id. Within a config a
    // document has exactly one run (the config fixes model/size/overlap), so
    // document_id uniquely keys the run — that's what lets the chunk copy below
    // remap document_embedding_id by joining on document_id.
    await tx`
      insert into document_embeddings
        (config_id, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count)
      select ${created.id}, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count
      from document_embeddings
      where config_id = ${source.id}
    `;

    // Clone the chunk rows (incl. vectors), pointing each at the matching new run.
    await tx`
      insert into ${tx(table)}
        (config_id, document_id, document_embedding_id, position, text, embedding)
      select ${created.id}, ch.document_id, nde.id, ch.position, ch.text, ch.embedding
      from ${tx(table)} ch
      join document_embeddings nde
        on nde.config_id = ${created.id} and nde.document_id = ch.document_id
      where ch.config_id = ${source.id}
    `;

    return created.id;
  });

  return getConfig(newId);
}
