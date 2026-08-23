// THE CLONE — a guest's whole workspace, copied from the seed account WITHOUT A
// SINGLE ROW BODY CROSSING THE WIRE (docs/guest-demo-plan.md).
//
// WHY THAT IS THE ENTIRE DESIGN. Supabase bills bytes leaving Postgres for the
// app server. It does not bill rows moving between tables inside Postgres. A
// clone written as `insert into … select … from …` reads the seed's rows off
// Postgres's own disk and writes new rows to Postgres's own disk; the wire
// carries the statement in and "INSERT 0 464" back. Zero egress per guest.
//
// The naive version costs 2.76 MB of egress per guest for nothing:
//
//   const rows = await sql`select * from chunks_voyage_4_lite_1024 where …`;
//   await sql`insert into chunks_voyage_4_lite_1024 ${sql(rows)}`;
//
// SO THE RULE FOR THIS FILE IS: no select returns a row body to JavaScript. The
// only values that come back are ids, counts, and one 32-character md5 per
// config. The id remapping is done in TEMP TABLES rather than by returning
// mappings, which keeps even the UUIDs inside Postgres and makes it structurally
// awkward for someone to later drop a `select *` into the seed path.
//
// WHY privilegedSql. This is the app's only legitimately CROSS-TENANT write: it
// reads the seed account's rows and writes the guest's. RLS would (correctly)
// show it nothing, and there is no identity that owns both sides. It is the
// fourth caller of privilegedSql, and lib/db.ts's "never gain a fourth without a
// good reason" is the bar this paragraph is trying to clear.
//
// WHY COLUMN LISTS ARE READ FROM information_schema. `configs` has 45 columns
// and gains one every few migrations. A hand-written list would clone a guest
// that silently lacks whatever was added last — and the symptom would be a
// default value quietly standing in for the seed's setting, which is invisible.
// Reading the live column list makes the clone correct by construction, and the
// price is one catalogue query per table.
import "server-only";

import type postgres from "postgres";

import { privilegedSql } from "@/lib/db";
import { answerFingerprint } from "@/lib/rag/semanticCacheCore";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

// The handle inside privilegedSql.begin(). NOT the `sql` Proxy from lib/db —
// that one is scoped to a user's transaction and would (correctly) see nothing
// of the seed account.
type Tx = postgres.TransactionSql;

// --- the little SQL builder --------------------------------------------------

// A column whose value is NOT copied verbatim: an id being remapped, an owner
// being rewritten, a foreign key being repointed at its clone.
type Overrides = Record<string, string>;

async function columnsOf(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx<{ column_name: string }[]>`
    select column_name
      from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by ordinal_position
  `;
  if (rows.length === 0) throw new Error(`demo clone: table ${table} has no columns (does it exist?)`);
  return rows.map((r) => r.column_name);
}

// insert into <table> (…) select … from <table> s <joins> where <where>
//
// `omit` drops a column from BOTH lists so its default applies — used for `id`
// on the tables nothing points at, which need no map and therefore no map join.
//
// `dedupe` narrows the copy to one row per key, newest first. Only semantic_cache
// needs it, and only because step 6 REWRITES fingerprints: rows that were
// distinct in the source (different corpus signatures) become the same key in the
// destination, and 0058's unique (user_id, embedding_model, llm_model,
// fingerprint, query_hash) then rejects the whole insert. Keeping the newest is
// not a tie-break, it is the row the cache would serve anyway —
// semantic_cache_lookup_idx orders by created_at desc.
//
// Every identifier here is an internal constant; the only caller-supplied values
// are the two user ids, which travel as bound parameters.
async function copyRows(
  tx: Tx,
  opts: {
    table: string;
    joins: string;
    where: string;
    overrides?: Overrides;
    omit?: string[];
    dedupe?: { on: string; newest: string };
    params: unknown[];
  },
): Promise<number> {
  const overrides = opts.overrides ?? {};
  const omit = new Set(opts.omit ?? []);
  const cols = (await columnsOf(tx, opts.table)).filter((c) => !omit.has(c));
  const targets = cols.map((c) => `"${c}"`).join(", ");
  const values = cols.map((c) => overrides[c] ?? `s."${c}"`).join(", ");
  const distinct = opts.dedupe ? `distinct on (${opts.dedupe.on}) ` : "";
  const order = opts.dedupe ? `order by ${opts.dedupe.on}, ${opts.dedupe.newest}` : "";

  const result = await tx.unsafe(
    `insert into "${opts.table}" (${targets})
     select ${distinct}${values}
       from "${opts.table}" s
       ${opts.joins}
      where ${opts.where}
      ${order}`,
    opts.params as never[],
  );
  return result.count ?? 0;
}

// old_id → new_id for one table, materialised inside Postgres. Pre-generating
// the new UUIDs (rather than correlating on a natural key after the fact) means
// every child insert is a plain join and no table needs a unique column to
// correlate on — which matters for chunks, where there isn't one.
async function buildMap(
  tx: Tx,
  name: string,
  selectIds: string,
  params: unknown[],
): Promise<number> {
  await tx.unsafe(
    `create temp table ${name} (
       old_id uuid primary key,
       new_id uuid not null default gen_random_uuid()
     ) on commit drop`,
  );
  const result = await tx.unsafe(`insert into ${name} (old_id) ${selectIds}`, params as never[]);
  return result.count ?? 0;
}

// --- the clone ---------------------------------------------------------------

// WHAT IS DELIBERATELY NOT CLONED, because a list of ten tables invites the
// question about the other thirty-odd:
//
//   eval_results, eval_runs, autotune_*, cluster_*   Derived measurements of runs
//     the guest did not make. They are the bulk of the seed's disk (eval_results
//     alone is 11 MB against the whole trimmed seed's ~8) and nothing a guest can
//     do produces more of them, since every path that would is gated.
//   config_chunk_overrides   The per-chunk tuning the master has accumulated.
//     Omitted as "a measurement the guest did not make", but it is the single
//     biggest EGRESS decision in the clone and worth naming as such: with
//     overrides present, retrieval takes the fusion path, where FUSION_DEEP_FLOOR
//     pulls a 200-row pool with text on every row (~470 KB) and re-reads every
//     override vector per query (~1.1 MB) — measured on the master, 2026-08-22.
//     Without them every question is one ~12 KB ANN. Leaving this out is worth
//     ~40x, and it is also what gives a visitor an untuned corpus to autotune.
//   embedding_cache   107 MB live, and it exists to avoid paying to RE-embed.
//     Guests cannot re-embed, so it would be pure storage for zero saving.
//   question_cache    Content-addressed and therefore cloneable for free — but it
//     only pays off during question GENERATION, which the demo blocks. Copying it
//     would be storage bought against a lever that is switched off.
//   user_provider_keys   Cannot be cloned even in principle: aadFor(userId,
//     provider) binds the AAD to the user id, so a copied row fails its GCM tag
//     check on first use. The key is re-sealed instead — see lib/demo/provision.
//
// The trimmed seed is not an optimisation, it is the design: the dominant
// per-guest cost is the CHUNK COUNT, so a smaller seed corpus is worth more than
// any table dropped from this list.
export type CloneSummary = {
  configId: string; // where to drop the guest — their leftmost open tab
  corpora: number;
  documents: number;
  configs: number;
  chunks: number;
  questions: number;
  cachedAnswers: number;
};

// THE PUBLISH OPTIONS — used by scripts/demo-snapshot.ts, never by a guest.
//
// A guest clone is the whole seed account copied into an empty destination. A
// SNAPSHOT is one config published into an account that already holds the last
// build (docs/demo-snapshot-plan.md). Both are the same copy; these two flags are
// the entire difference, which is why publishing did not need its own copier.
export type CloneOptions = {
  // Publish exactly this config, and ONLY the documents that have chunks in it.
  //
  // The filter is not tidiness. `documents` is copied by OWNER, so without it an
  // un-ingested PDF sitting in the master's library is indistinguishable from
  // corpus content and lands in every guest's User tab.
  onlyConfigId?: string;
  // Wipe the destination's workspace first, IN THE SAME TRANSACTION, so that
  // re-publishing replaces the last build rather than stacking a second copy
  // beside it — and so a publish that throws leaves the previous build serving.
  replaceDestination?: boolean;
};

// Copy the seed account's workspace into `guestId`, in ONE transaction.
//
// It is fast — no vector math, no provider calls (the Voyage key is sealed by
// the caller, before this runs) — so it is inline in the provisioning request
// rather than a background job. If that ever stops being true, the sliced-jobs
// machinery is already there.
export async function cloneSeedWorkspace(
  seedId: string,
  guestId: string,
  opts: CloneOptions = {},
): Promise<CloneSummary> {
  return privilegedSql.begin(async (tx) => {
    const ids = [seedId, guestId];
    const only = opts.onlyConfigId ?? null;

    // --- 0. republish: clear the destination's previous build ----------------
    //
    // EXPLICIT, not left to a cascade from `configs`. semantic_cache.config_id is
    // ON DELETE **SET NULL** where every other child of `configs` cascades, so
    // dropping the configs alone would leave the last build's answers behind as
    // rows with a null config: invisible, un-fingerprintable, copied into no
    // guest, and ~350 more of them per publish forever. The rest of the list is
    // this function's own write set — documents cascade to chunks, embeddings and
    // the question bank; configs cascade to everything keyed by tab.
    if (opts.replaceDestination) {
      await tx`delete from semantic_cache where user_id = ${guestId}`;
      await tx`delete from semantic_cache_thresholds where user_id = ${guestId}`;
      await tx`delete from documents where user_id = ${guestId}`;
      await tx`delete from configs where user_id = ${guestId}`;
      await tx`delete from corpora where user_id = ${guestId}`;
    }

    // Which documents are IN the published config, resolved through its CHUNK
    // table rather than document_embeddings: an ingest row can outlive its
    // vectors (a cleared or failed run), and a document with no chunks is a name
    // in the library that answers nothing.
    let docSelect = `select id from documents where user_id = $1`;
    if (only) {
      const [cfg] = await tx<{ base_model: string }[]>`
        select base_model from configs where id = ${only} and user_id = ${seedId}
      `;
      if (!cfg) throw new Error(`demo clone: config ${only} is not owned by ${seedId}`);
      const table = chunksTable(cfg.base_model, modelDimension(cfg.base_model));
      docSelect = `select distinct document_id from "${table}" where config_id = $1`;
    }

    // --- 1. the id maps ------------------------------------------------------
    // The corpus map follows the published config rather than the owner, so one
    // tab cannot drag the master's other corpora across. `configs.corpus_id` is
    // nullable, so this map is routinely empty on both paths.
    await buildMap(
      tx,
      "_map_corpus",
      only
        ? `select id from corpora where user_id = $1
             and id = (select corpus_id from configs where id = $2)`
        : `select id from corpora where user_id = $1`,
      only ? [seedId, only] : [seedId],
    );
    // Its ONE parameter is the config when filtering and the owner when not —
    // Postgres refuses a statement carrying a parameter it never references
    // ("could not determine data type of parameter $1"), so the pair travels
    // together rather than a fixed [seedId, only] with one half unused.
    await buildMap(tx, "_map_doc", docSelect, only ? [only] : [seedId]);
    const mappedConfigs = await buildMap(
      tx,
      "_map_config",
      only
        ? `select id from configs where user_id = $1 and id = $2`
        : `select id from configs where user_id = $1`,
      only ? [seedId, only] : [seedId],
    );
    if (only && mappedConfigs !== 1) {
      throw new Error(`demo clone: config ${only} is not owned by ${seedId}`);
    }
    await buildMap(
      tx,
      "_map_de",
      `select de.id from document_embeddings de
         join _map_config mc on mc.old_id = de.config_id`,
      [],
    );
    // eval_questions carries no user_id and no config_id — it hangs off
    // documents, which is what scopes it (0051 §3b's transitive ownership).
    await buildMap(
      tx,
      "_map_question",
      `select q.id from eval_questions q
         join _map_doc md on md.old_id = q.document_id`,
      [],
    );

    // --- 2. corpora, documents, configs -------------------------------------
    const corpora = await copyRows(tx, {
      table: "corpora",
      joins: `join _map_corpus m on m.old_id = s.id`,
      where: `s.user_id = $1`,
      overrides: { id: "m.new_id", user_id: "$2" },
      params: ids,
    });

    // documents' unique key is (user_id, content_hash) since 0049, so copying
    // the hash verbatim under a new owner cannot collide with the seed's.
    const documents = await copyRows(tx, {
      table: "documents",
      joins: `join _map_doc m on m.old_id = s.id`,
      where: `s.user_id = $1`,
      overrides: { id: "m.new_id", user_id: "$2" },
      params: ids,
    });

    await copyRows(tx, {
      table: "corpus_documents",
      joins: `join _map_corpus mc on mc.old_id = s.corpus_id
              join _map_doc md on md.old_id = s.document_id`,
      where: `true`,
      overrides: { corpus_id: "mc.new_id", document_id: "md.new_id" },
      params: [],
    });

    // LEFT join on the corpus map: configs.corpus_id is nullable (a corpus-less
    // starter tab), and an inner join would silently drop exactly those.
    const configs = await copyRows(tx, {
      table: "configs",
      joins: `join _map_config m on m.old_id = s.id
              left join _map_corpus mc on mc.old_id = s.corpus_id`,
      where: `s.user_id = $1`,
      overrides: { id: "m.new_id", user_id: "$2", corpus_id: "mc.new_id" },
      params: ids,
    });

    // --- 3. the embedding runs and their chunks ------------------------------
    await copyRows(tx, {
      table: "document_embeddings",
      joins: `join _map_de m on m.old_id = s.id
              join _map_doc md on md.old_id = s.document_id
              join _map_config mc on mc.old_id = s.config_id`,
      where: `true`,
      overrides: { id: "m.new_id", document_id: "md.new_id", config_id: "mc.new_id" },
      params: [],
    });

    // Which chunks_* tables the seed's configs actually use, derived from their
    // base_model rather than hardcoded: the demo is Voyage-only today, and a
    // seed that gains a second ingestable model should clone rather than
    // silently arrive with an empty tab.
    // Read through the config map, not by owner: a publish of one tab must consult
    // that tab's model, or a master account holding a second ingestable model
    // would send the snapshot walking a chunk table it copies nothing from.
    const models = await tx<{ base_model: string }[]>`
      select distinct s.base_model from configs s join _map_config m on m.old_id = s.id
    `;
    const tables = new Set<string>();
    for (const { base_model } of models) {
      try {
        tables.add(chunksTable(base_model, modelDimension(base_model)));
      } catch {
        // A non-ingestable base model has no chunks table and therefore nothing
        // to clone. Not an error: the config still copies, it just has no
        // vectors under it — exactly its state in the seed account.
      }
    }

    // ONE map across every chunk table. UUIDs are unique regardless of which
    // table they came from, and eval_labels.source_chunk_id is a bare uuid with
    // no foreign key (the target table varies per model), so a single map is
    // what that column actually needs.
    await buildMap(tx, "_map_chunk", `select null::uuid where false`, []);
    let chunks = 0;
    for (const table of tables) {
      await tx.unsafe(
        `insert into _map_chunk (old_id)
         select c.id from "${table}" c join _map_config mc on mc.old_id = c.config_id`,
      );
      chunks += await copyRows(tx, {
        table,
        joins: `join _map_chunk m on m.old_id = s.id
                join _map_doc md on md.old_id = s.document_id
                join _map_de mde on mde.old_id = s.document_embedding_id
                join _map_config mc on mc.old_id = s.config_id`,
        where: `true`,
        overrides: {
          id: "m.new_id",
          document_id: "md.new_id",
          document_embedding_id: "mde.new_id",
          config_id: "mc.new_id",
        },
        params: [],
      });
    }

    // --- 4. the eval bank ----------------------------------------------------
    const questions = await copyRows(tx, {
      table: "eval_questions",
      joins: `join _map_question m on m.old_id = s.id
              join _map_doc md on md.old_id = s.document_id`,
      where: `true`,
      overrides: { id: "m.new_id", document_id: "md.new_id" },
      params: [],
    });

    // `id` omitted so the default mints one: nothing points at a label or a
    // question embedding, so neither needs a map.
    await copyRows(tx, {
      table: "eval_labels",
      joins: `join _map_question mq on mq.old_id = s.eval_question_id
              join _map_de mde on mde.old_id = s.document_embedding_id
              join _map_chunk mch on mch.old_id = s.source_chunk_id`,
      where: `true`,
      overrides: {
        eval_question_id: "mq.new_id",
        document_embedding_id: "mde.new_id",
        source_chunk_id: "mch.new_id",
      },
      omit: ["id"],
      params: [],
    });

    await copyRows(tx, {
      table: "eval_question_embeddings",
      joins: `join _map_question mq on mq.old_id = s.eval_question_id`,
      where: `true`,
      overrides: { eval_question_id: "mq.new_id" },
      omit: ["id"],
      params: [],
    });

    // --- 5. the pre-warmed answers ------------------------------------------
    // The INNER join on the config map drops rows whose config_id is null. That
    // is deliberate: their fingerprint could not be rewritten in step 6 (there
    // is no config to recompute a document signature for), so they would be
    // unreachable rows occupying a guest's disk forever.
    //
    // Deduped per DESTINATION config, because that is the granularity step 6
    // rewrites at: two configs may legitimately share a query_hash and end up
    // with different fingerprints, so config_id has to be part of the key here
    // even though 0058 dropped it from the constraint.
    const cachedAnswers = await copyRows(tx, {
      table: "semantic_cache",
      joins: `join _map_config mc on mc.old_id = s.config_id`,
      where: `s.user_id = $1`,
      overrides: { user_id: "$2", config_id: "mc.new_id" },
      omit: ["id"],
      dedupe: {
        on: `s.config_id, s.embedding_model, s.llm_model, s.query_hash`,
        newest: `s.created_at desc`,
      },
      params: ids,
    });

    await copyRows(tx, {
      table: "semantic_cache_thresholds",
      joins: ``,
      where: `s.user_id = $1`,
      overrides: { user_id: "$2" },
      params: ids,
    });

    // --- 6. REWRITE THE CACHE FINGERPRINTS, or step 5 was for nothing --------
    //
    // currentFingerprint hashes documentSignature, which is an md5 over the
    // DOCUMENT IDS in the config's chunks table (lib/rag/semanticCache.ts). The
    // clone minted new document UUIDs, so a guest computes a different
    // fingerprint than the seed, and the lookup's `and fingerprint = $fingerprint`
    // matches none of the rows just copied. Every pre-warmed answer would be
    // unreachable and the demo would degrade to "no answer key" on every
    // question — silently, because a cache miss is not an error.
    //
    // The signature is recomputed over the GUEST's rows and stamped on the
    // guest's cache rows in the same transaction. Only the md5 crosses the wire.
    //
    // question_cache deliberately needs none of this: it keys on a hash of the
    // chunk TEXT (0055), which the clone copies byte for byte. Content-addressed
    // caches clone; id-addressed ones need a rewrite.
    const cfgs = await tx<{ id: string; base_model: string; cascade_enabled: boolean }[]>`
      select id, base_model, cascade_enabled from configs where user_id = ${guestId}
    `;
    for (const cfg of cfgs) {
      let table: string;
      try {
        table = chunksTable(cfg.base_model, modelDimension(cfg.base_model));
      } catch {
        continue; // non-ingestable model: no chunks, so no signature to compute
      }
      const [sig] = await tx.unsafe<{ docs: string }[]>(
        `select coalesce(
                  md5(string_agg(distinct document_id::text, ',' order by document_id::text)),
                  'empty') as docs
           from "${table}" where config_id = $1`,
        [cfg.id] as never[],
      );
      const fingerprint = answerFingerprint({
        cascadeEnabled: cfg.cascade_enabled,
        documents: sig.docs,
      });
      await tx`
        update semantic_cache
           set fingerprint = ${fingerprint}
         where user_id = ${guestId} and config_id = ${cfg.id}
      `;
    }

    // --- 7. where to drop them ----------------------------------------------
    // The same ordering listConfigs() uses, so the guest lands on the tab the
    // app would have shown them anyway.
    const [first] = await tx<{ id: string }[]>`
      select id from configs
       where user_id = ${guestId} and is_open
       order by tab_order, created_at
       limit 1
    `;
    const [any] = first
      ? [first]
      : await tx<{ id: string }[]>`
          select id from configs where user_id = ${guestId} order by created_at limit 1
        `;
    if (!any) throw new Error("demo clone: the seed account owns no configs");

    return {
      configId: any.id,
      corpora,
      documents,
      configs,
      chunks,
      questions,
      cachedAnswers,
    };
  }) as Promise<CloneSummary>;
}
