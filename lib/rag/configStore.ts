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
import {
  addDocumentToCorpus,
  createCorpus,
  dedupCorporaDocuments,
} from "@/lib/rag/corpusStore";
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
  corpusId: string | null;   // null = detached (corpus deleted, or created without one)
  corpusName: string | null;
  corpusSync: boolean;       // auto-sync membership with the corpus (0017)
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
  corpus_id: string | null;
  corpus_name: string | null;
  corpus_sync: boolean;
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
    corpusSync: row.corpus_sync,
    isOpen: row.is_open,
    tabOrder: row.tab_order,
    createdAt: row.created_at.getTime(),
  };
}

// Open tabs, left-to-right. This is the tab bar's source of truth.
export async function listConfigs(): Promise<ConfigSummary[]> {
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.corpus_sync, c.is_open,
           c.tab_order, c.created_at
    from configs c
    left join corpora co on co.id = c.corpus_id
    where c.is_open = true
    order by c.tab_order, c.created_at
  `;
  return rows.map(toSummary);
}

// Closed/saved configs for the "reopen" menu (newest first — most likely wanted).
export async function listClosedConfigs(): Promise<ConfigSummary[]> {
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.corpus_sync, c.is_open,
           c.tab_order, c.created_at
    from configs c
    left join corpora co on co.id = c.corpus_id
    where c.is_open = false
    order by c.created_at desc
  `;
  return rows.map(toSummary);
}

export async function getConfig(id: string): Promise<ConfigSummary | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<ConfigJoinRow[]>`
    select c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k,
           c.llm_model, c.corpus_id, co.name as corpus_name, c.corpus_sync, c.is_open,
           c.tab_order, c.created_at
    from configs c
    left join corpora co on co.id = c.corpus_id
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
  corpusId: string | null;
  corpusSync?: boolean;
  name?: string | null;
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  llmModel: string;
};

// Insert a config row, opened at the end of the tab bar. Low-level: the caller
// supplies the (optional) corpus and settings. (createEmptyConfig and
// duplicateConfig build on this for the two real entry points.)
export async function createConfig(input: NewConfigInput): Promise<ConfigSummary> {
  const tabOrder = await nextTabOrder();
  const rows = await sql<{ id: string }[]>`
    insert into configs
      (corpus_id, corpus_sync, name, base_model, chunk_size, chunk_overlap, top_k,
       llm_model, is_open, tab_order)
    values
      (${input.corpusId}, ${input.corpusSync ?? false}, ${input.name ?? null},
       ${input.baseModel}, ${input.chunkSize}, ${input.chunkOverlap}, ${input.topK},
       ${input.llmModel}, true, ${tabOrder})
    returning id
  `;
  const created = await getConfig(rows[0].id);
  if (!created) throw new Error("Config vanished immediately after insert.");
  return created;
}

// The "+ New" tab: a corpus-less config seeded with the lib/config.ts defaults.
// Starts with no documents — the user ingests into it. Since 0017 no throwaway
// corpus is auto-created (those used to pile up as empty orphans); the user
// attaches/saves a corpus from the create dialog when they want one.
export async function createEmptyConfig(name?: string | null): Promise<ConfigSummary> {
  return createConfig({
    corpusId: null,
    name: name?.trim() || null,
    baseModel: config.embeddingModel,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    topK: config.topK,
    llmModel: config.llmModel,
  });
}

export type CreateConfigOptions = {
  name?: string | null;
  // Source corpora whose (de-duplicated) documents seed the config. Empty =
  // start blank.
  corpusIds: string[];
  // Save the de-duped selection as a NEW corpus and attach the config to it.
  saveAsCorpus?: { name: string } | null;
  // Auto-sync membership with the attached corpus. Only takes effect when the
  // config ends up attached to a corpus (a single selection, or the freshly
  // saved one).
  sync?: boolean;
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
};

// Create a config from a multi-corpus selection (corpus decoupling, 0017). The
// caller then streams the populate route (body `{ corpusIds }`) to embed the
// de-duped union under the new settings. The config is ATTACHED to a corpus
// only when the target is unambiguous: the saved-as corpus, or the single
// selected one; with several corpora and no save-as it keeps its docs but
// points at no corpus. llm_model stays the lib/config.ts default.
export async function createConfigWithSettings(
  opts: CreateConfigOptions,
): Promise<ConfigSummary> {
  let corpusId: string | null = null;
  if (opts.saveAsCorpus) {
    corpusId = await createCorpus(
      opts.saveAsCorpus.name.trim() || opts.name?.trim() || "New corpus",
    );
    const { docs } = await dedupCorporaDocuments(opts.corpusIds);
    for (const d of docs) await addDocumentToCorpus(corpusId, d.id);
  } else if (opts.corpusIds.length === 1) {
    corpusId = opts.corpusIds[0];
  }
  return createConfig({
    corpusId,
    corpusSync: Boolean(opts.sync && corpusId),
    name: opts.name?.trim() || null,
    baseModel: opts.baseModel,
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    topK: opts.topK,
    llmModel: config.llmModel,
  });
}

// Configs auto-synced to a corpus (pointer set AND sync on) — the set the
// pipeline propagates corpus membership changes into.
export async function listSyncedConfigIds(corpusId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from configs
    where corpus_id = ${corpusId} and corpus_sync = true
    order by created_at
  `;
  return rows.map((r) => r.id);
}

// Toggle a config's corpus auto-sync (the banner toggle). Returns null when the
// config doesn't exist. Toggling a detached config (corpus_id null) is a no-op
// in effect until a corpus is attached.
export async function setCorpusSync(
  id: string,
  sync: boolean,
): Promise<ConfigSummary | null> {
  const rows = await sql`
    update configs set corpus_sync = ${sync}, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0 ? getConfig(id) : null;
}

// Saver-mode toggle (0032): flip the per-config cascade_enabled flag from
// Settings → Savings. Read on the hot path via activeConfig().cascadeEnabled;
// this is the writer. Returns the new value, or null when the config is gone.
export async function setCascadeEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean | null> {
  if (!isUuid(id)) return null;
  const rows = await sql`
    update configs set cascade_enabled = ${enabled}, updated_at = now()
    where id = ${id}
    returning id
  `;
  return rows.length > 0 ? enabled : null;
}

// Update a config's processing settings IN PLACE (the bulk-actions "change this
// config" flow). Pure row update — the caller (lib/rag/reconfigure) owns the
// re-embed + eval-label remap that a model/size change requires.
export async function updateConfigSettings(
  id: string,
  changes: {
    baseModel?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    topK?: number;
  },
): Promise<ConfigSummary | null> {
  const current = await getConfig(id);
  if (!current) return null;
  await sql`
    update configs
    set base_model = ${changes.baseModel ?? current.baseModel},
        chunk_size = ${changes.chunkSize ?? current.chunkSize},
        chunk_overlap = ${changes.chunkOverlap ?? current.chunkOverlap},
        top_k = ${changes.topK ?? current.topK},
        updated_at = now()
    where id = ${id}
  `;
  return getConfig(id);
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
        (corpus_id, corpus_sync, name, base_model, chunk_size, chunk_overlap, top_k,
         llm_model, is_open, tab_order)
      values
        (${source.corpusId}, ${source.corpusSync}, ${copyName}, ${source.baseModel},
         ${source.chunkSize}, ${source.chunkOverlap}, ${source.topK}, ${source.llmModel},
         true, ${tabOrder})
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
