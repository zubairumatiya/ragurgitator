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

import { config } from "@/lib/config";
import { privilegedSql } from "@/lib/db";
import {
  BANKED_QUESTION_CAP,
  FROZEN_REASON,
  SHADOW_CURVE_CAP,
  SHADOW_QUEUE_CAP,
} from "@/lib/demo/frozen";
import { PUBLISHED_SWEEP_FINGERPRINT } from "@/lib/rag/publishedSweep";
import { PUBLISHED_REPLAY_FINGERPRINT } from "@/lib/rag/replayStore";
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
// `dedupe` narrows the copy to one row per key, `tieBreak` deciding which row
// wins. semantic_cache needs it because step 6 REWRITES fingerprints: rows that
// were distinct in the source (different corpus signatures) become the same key
// in the destination, and 0058's unique (user_id, embedding_model, llm_model,
// fingerprint, query_hash) then rejects the whole insert. There the tie-break is
// not really a tie-break — `created_at desc` is the row the cache would serve
// anyway, since semantic_cache_lookup_idx orders by it. Step 4e uses the same
// machinery to spread a capped copy across passages instead.
//
// `limit` caps the copy. It applies AFTER the dedupe, so "one row per key, at
// most N keys" is one call — which is exactly what a cap on a published set
// wants, and why the two options live together.
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
    dedupe?: { on: string; tieBreak: string };
    limit?: number;
    params: unknown[];
  },
): Promise<number> {
  const overrides = opts.overrides ?? {};
  const omit = new Set(opts.omit ?? []);
  const cols = (await columnsOf(tx, opts.table)).filter((c) => !omit.has(c));
  const targets = cols.map((c) => `"${c}"`).join(", ");
  const values = cols.map((c) => overrides[c] ?? `s."${c}"`).join(", ");
  const distinct = opts.dedupe ? `distinct on (${opts.dedupe.on}) ` : "";
  const order = opts.dedupe ? `order by ${opts.dedupe.on}, ${opts.dedupe.tieBreak}` : "";
  // Number, not a bound parameter: every caller passes a module constant, and a
  // bind here would collide with the positional params the joins already use.
  const limit = opts.limit === undefined ? "" : `limit ${Number(opts.limit)}`;

  const result = await tx.unsafe(
    `insert into "${opts.table}" (${targets})
     select ${distinct}${values}
       from "${opts.table}" s
       ${opts.joins}
      where ${opts.where}
      ${order}
      ${limit}`,
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
//   autotune_*, cluster_*   Derived measurements of runs the guest did not make,
//     and nothing a guest can do produces more of them since every path that
//     would is gated.
//   eval_results, EXCEPT the `retrieval_state = 'baseline'` generation. The table
//     holds 11 MB for this corpus against the whole trimmed seed's ~8, but that is
//     24 historical re-scores of the same questions. The one generation a guest's
//     override-free config can actually reproduce is 472 rows and 169 KB, and
//     without it the Eval tab is a dashboard with its instruments removed — see
//     step 4b.
//   config_chunk_overrides   The per-chunk tuning the master has accumulated.
//     Omitted as "a measurement the guest did not make", but it is the single
//     biggest EGRESS decision in the clone and worth naming as such: with
//     overrides present, retrieval takes the fusion path, where FUSION_DEEP_FLOOR
//     pulls a 200-row pool with text on every row (~470 KB) and re-reads every
//     override vector per query (~1.1 MB) — measured on the master, 2026-08-22.
//     Without them every question is one ~12 KB ANN. Leaving this out is worth
//     ~40x, and it is also what gives a visitor an untuned corpus to autotune.
//   embedding_cache   107 MB live, and it exists to avoid paying to RE-embed.
//     Guests cannot re-embed, so it would be pure storage for zero saving. ONE
//     thing did read it — the full-corpus replay behind Appraise → Models — and
//     the answer was to carry that measurement's RESULT rather than its inputs:
//     17 rows against 107 MB. See step 5c.
//   replay_metrics IS cloned now — step 5c — and, like the shadow log below, it
//     spent this demo's whole life in neither list. The plan's own bullet for the
//     phase that fixed it named the wrong table (eval_model_trials, which the
//     replay REPLACED in 0043), which is what a table nobody has written down
//     costs you.
//   published_sweep IS cloned now — step 5d. It is the same trade as
//     replay_metrics: the sweep's INPUTS are ~510 texts under eleven models of
//     embedding spend a guest cannot make, so the publish carries one jsonb
//     answer instead. Unlike every other entry in either list, the master does
//     not keep this row on its own — scripts/demo-snapshot writes it at publish
//     time, because runKeyModelSweep stores nothing.
//   semantic_cache_pairs is in NEITHER list, which is the gap phase 3 of
//     docs/demo-cache-lab-plan.md exists to close. Naming it here rather than
//     leaving it unmentioned, because an unmentioned table looks exactly like a
//     considered one — which is how the shadow log below shipped empty for two
//     phases.
//   semantic_cache_shadow IS cloned now, as a SAMPLE — see step 5b. It is listed
//     here because it spent two phases in neither list, which is how the demo
//     shipped its most distinctive chart empty: a table that is merely unmentioned
//     looks identical to one that was considered and rejected.
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
  results: number;
  runs: number;
  rankings: number; // graded-nDCG truth rows — the size of the drilldown set
  frozen: number; // questions a visitor may look at but not move (step 4d)
  bankedQuestions: number; // spare wording "Add cached" can hand out for free (step 4e)
  bankedAvailable: number; // passages that HAD banked wording, before the cap
  cachedAnswers: number;
  shadowEvents: number; // judged + queued shadow rows behind the calibration curve
  shadowQueued: number; // of those, the ones arriving unjudged for the human queue
  replayRows: number; // the published model comparison, one row per model (step 5c)
  replayScored: number; // of those, the ones with metrics rather than "not scorable"
  sweepRows: number; // the published cache-key sweep — 0 or 1 (step 5d)
  sweepModels: number; // leaderboard rows inside it, i.e. whether §4 has a table
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
  // THE TWELVE — the questions a visitor may actually put their hands on. The
  // publisher passes the set it selected; a GUEST clone passes nothing and copies
  // what the snapshot already says, which IS that set.
  //
  // Two things hang off it, and they are the same fact seen from two sides:
  //   step 4c  these get a graded-nDCG truth ranking, so they are the ones whose
  //            drilldown shows an ideal ordering rather than a grey chip;
  //   step 4d  every OTHER question is frozen, so they are the ones a re-score
  //            and an autotune are allowed to move (phase 4).
  //
  // Undefined and [] mean opposite things on purpose: undefined is "copy what is
  // there", [] is "copy none". A publish that selected nothing must publish
  // nothing rather than silently falling back to all 472 — and, since 4d is the
  // complement, [] freezes the whole bank rather than thawing it.
  tunableQuestionIds?: string[];
};

// Freeze every question in the DESTINATION account except the ones the publisher
// selected — step 4d's publish half.
//
// Runs entirely in the new id space: `tunable` holds the MASTER's ids, so the
// exclusion goes through _map_question rather than comparing them to the ids
// that were just minted. Getting that backwards would freeze nothing (no new id
// is ever equal to an old one), which is a silent failure — the publish census
// would report 0 frozen and the build would ship with all 472 live.
//
// `on conflict do nothing` because a re-publish into a destination that step 0
// did not wipe would otherwise abort on the previous build's rows.
async function freezeAllBut(tx: Tx, guestId: string, tunable: string[]): Promise<number> {
  const result = await tx.unsafe(
    `insert into config_question_ignores (config_id, eval_question_id, reason)
     select distinct de.config_id, q.id, $3
       from eval_questions q
       join eval_labels l on l.eval_question_id = q.id
       join document_embeddings de on de.id = l.document_embedding_id
       join _map_config mc on mc.new_id = de.config_id
       join documents d on d.id = q.document_id
      where d.user_id = $1
        and not exists (
          select 1 from _map_question mq
           where mq.new_id = q.id and mq.old_id = any($2::uuid[])
        )
     on conflict (config_id, eval_question_id) do nothing`,
    [guestId, tunable, FROZEN_REASON] as never[],
  );
  return result.count ?? 0;
}

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
    // guest, and ~350 more of them per publish forever. question_cache (step 4e)
    // is here for a related reason: it hangs off user_profiles ALONE, by design,
    // so that banked wording outlives the documents and configs it was written
    // for — which also means no cascade in this list reaches it. The rest is this
    // function's own write set — documents cascade to chunks, embeddings and the
    // question bank; configs cascade to everything keyed by tab.
    if (opts.replaceDestination) {
      await tx`delete from question_cache where user_id = ${guestId}`;
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
    //
    // SCOPED TO QUESTIONS THAT HAVE A LABEL under this config, which drops 82 of
    // the master's 554. They are labeled, but under a DIFFERENT config's chunking,
    // so their label resolves to no document_embeddings row here: they arrive with
    // no ground truth, score nothing, and read as permanently unscored. In an
    // account holding exactly one config that is not a gap waiting to be filled,
    // it is a row that can never become anything — the very "554 questions, every
    // one reading as unscored" the analytics plan opens by complaining about.
    // `distinct` because a question may carry more than one label.
    await buildMap(
      tx,
      "_map_question",
      `select distinct q.id from eval_questions q
         join _map_doc md on md.old_id = q.document_id
         join eval_labels l on l.eval_question_id = q.id
         join _map_de mde on mde.old_id = l.document_embedding_id`,
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

    // Labels DO need a map, because eval_results.eval_label_id points at one and
    // every aggregate in evalStore joins on it (`join active_labels al on
    // al.label_id = r.eval_label_id`). A result copied against an unmapped label id
    // would point into the MASTER's rows — invisible to the guest's RLS, so it
    // would not error, it would just silently score nothing.
    //
    // The map's joins must match the copy's EXACTLY. A label in the map but not in
    // the copy (source_chunk_id that failed to map, say) would let the eval_results
    // insert below reference a row that was never written, and the foreign key
    // would abort the whole clone.
    await buildMap(
      tx,
      "_map_label",
      `select l.id from eval_labels l
         join _map_question mq on mq.old_id = l.eval_question_id
         join _map_de mde on mde.old_id = l.document_embedding_id
         join _map_chunk mch on mch.old_id = l.source_chunk_id`,
      [],
    );

    await copyRows(tx, {
      table: "eval_labels",
      joins: `join _map_label ml on ml.old_id = s.id
              join _map_question mq on mq.old_id = s.eval_question_id
              join _map_de mde on mde.old_id = s.document_embedding_id
              join _map_chunk mch on mch.old_id = s.source_chunk_id`,
      where: `true`,
      overrides: {
        id: "ml.new_id",
        eval_question_id: "mq.new_id",
        document_embedding_id: "mde.new_id",
        source_chunk_id: "mch.new_id",
      },
      params: [],
    });

    // `id` omitted so the default mints one: nothing points at a question
    // embedding, so it needs no map.
    await copyRows(tx, {
      table: "eval_question_embeddings",
      joins: `join _map_question mq on mq.old_id = s.eval_question_id`,
      where: `true`,
      overrides: { eval_question_id: "mq.new_id" },
      omit: ["id"],
      params: [],
    });

    // --- 4b. the published scores -------------------------------------------
    //
    // WHY ONLY THE `retrieval_state = 'baseline'` GENERATION, and not the latest.
    //
    // config_chunk_overrides is not cloned, so a guest's config has zero overrides
    // and retrievalStateFingerprint() returns the literal string "baseline" for it.
    // evalStore picks a question's result by `(retrieval_state is not distinct from
    // currentState) desc, scored_at desc`, so the rows that will actually SURFACE in
    // a guest's Eval tab are the ones stamped 'baseline'. Copying the master's tuned
    // latest instead would copy rows measured in a vector space the guest does not
    // have: they would rank below the state match, or show scores no query in the
    // guest workspace can reproduce.
    //
    // Note this is the `retrieval_state` VALUE 'baseline', not the `is_baseline`
    // boolean — 0057's shadow leg is a different measurement and is excluded.
    //
    // One row per (label, k): the state holds 652 rows for 472 questions, the extras
    // being re-scores within the same state. The newest is the one evalStore would
    // serve anyway, and 472 rows is 169 KB.
    const results = await copyRows(tx, {
      table: "eval_results",
      joins: `join _map_question mq on mq.old_id = s.eval_question_id
              join _map_label ml on ml.old_id = s.eval_label_id`,
      where: `s.retrieval_state = 'baseline' and not s.is_baseline`,
      overrides: {
        eval_question_id: "mq.new_id",
        eval_label_id: "ml.new_id",
        // retrieved_ids is a uuid[] OF CHUNK IDS — the ranked window the question
        // pulled back — and the clone minted new chunk UUIDs. Left the untranslated
        // ids in place it would resolve to nothing and every drilldown would render
        // an empty top-k against a hit badge saying rank 1.
        //
        // LEFT join, and `with ordinality` to hold the order: rank IS the position
        // here. An id that failed to map becomes a null in place rather than being
        // dropped, because dropping it would silently renumber every rank below it
        // and turn a rank-4 hit into a rank-3 one. (Measured 2026-08-23: all 2,360
        // ids in this generation map, so the left join is insurance, not a fix.)
        // coalesce guards the empty-array case, where array_agg returns null into a
        // not-null column.
        retrieved_ids: `coalesce(
          (select array_agg(mch.new_id order by u.ord)
             from unnest(s.retrieved_ids) with ordinality u(old_id, ord)
             left join _map_chunk mch on mch.old_id = u.old_id),
          '{}'::uuid[])`,
      },
      omit: ["id"],
      dedupe: { on: `s.eval_label_id, s.k`, tieBreak: `s.scored_at desc` },
      params: [],
    });

    // The aggregate snapshots behind the "As published" card and the run-history
    // panel. Scoped through the config map, which also drops the pre-0011 rows
    // whose config_id is null.
    //
    // On the PUBLISH hop these are the master's tuned runs and are wrong for the
    // demo — scripts/demo-snapshot.ts replaces them with one row measured over the
    // generation just copied. On the guest hop that corrected row is what lands
    // here, which is why this copy is unconditional rather than publish-only.
    const runs = await copyRows(tx, {
      table: "eval_runs",
      joins: `join _map_config mc on mc.old_id = s.config_id`,
      where: `true`,
      overrides: { config_id: "mc.new_id" },
      omit: ["id"],
      params: [],
    });

    // --- 4c. the graded-nDCG truth rankings ----------------------------------
    //
    // WHY ONLY A HANDFUL, when the other 4b tables are copied whole.
    //
    // Per-question nDCG is ndcg(idealOrder, retrieved_ids, k), and idealOrder is
    // this question's is_truth eval_rankings row (evalStore's getTruthOrder). No
    // truth row means null means the grey "ungraded" chip the dashboard already
    // renders — so the SIZE OF THE GRADED SET IS EXACTLY THE SIZE OF THIS COPY,
    // with no UI branch anywhere.
    //
    // The master holds one for all 472 questions and they are 1.26 MB — three
    // times the whole rest of the analytics copy, to grade 460 questions a guest
    // cannot tune, re-rank or re-score. Twelve is 33 KB. The asymmetry is the
    // demo's point rather than a corner cut: the graded drilldown marks the part
    // a visitor can put their hands on (docs/demo-analytics-plan.md, phase 3).
    //
    // ONLY is_truth. The master's workbench also holds llm_pool / llm_rerank /
    // manual alternatives for some questions; those are candidates in a panel
    // whose Rank buttons a guest cannot press, and their `details.signature`
    // freshness is computed against an aggregate that may not have come along.
    const rankings = await copyRows(tx, {
      table: "eval_rankings",
      joins: `join _map_question mq on mq.old_id = s.eval_question_id
              join _map_de mde on mde.old_id = s.document_embedding_id`,
      where: `s.is_truth and ($1::uuid[] is null or s.eval_question_id = any($1::uuid[]))`,
      overrides: {
        eval_question_id: "mq.new_id",
        document_embedding_id: "mde.new_id",
        // The ideal order, remapped the same way step 4b remaps retrieved_ids and
        // for the same reason: these are CHUNK ids and the clone minted new ones.
        // Left join + ordinality so an unmappable id becomes a null holding its
        // place — dropping it would promote every chunk below it in the ideal
        // order, which is a different ground truth, silently. (Measured
        // 2026-08-23: all 14,160 ids across the master's 472 rows resolve.)
        chunk_ids: `coalesce(
          (select array_agg(mch.new_id order by u.ord)
             from unnest(s.chunk_ids) with ordinality u(old_id, ord)
             left join _map_chunk mch on mch.old_id = u.old_id),
          '{}'::uuid[])`,
        // details.perModelRanks is KEYED BY CHUNK ID — it is what draws the
        // "[4-lite:14 4:12 …]" provenance beside each row of the drilldown
        // (ranking.ts resolve(), NdcgRankingPanel ChunkRow). Left alone it would
        // key on the master's ids, every lookup would miss, and the annotation
        // would just not appear: a degradation with no error and no symptom but
        // an emptier panel. Rebuilt here against the new ids.
        //
        // The inner join DROPS a rank for a chunk that did not map, which is
        // right — there is no row to draw it beside. `? 'perModelRanks'` guards
        // the rankings that have none (llm/manual kinds today, and any future
        // aggregate written without provenance): jsonb_set would otherwise CREATE
        // the key, inventing an empty object where the code expects undefined.
        details: `case when s.details ? 'perModelRanks'
                  then jsonb_set(s.details, '{perModelRanks}', coalesce(
                    (select jsonb_object_agg(mch.new_id::text, e.value)
                       from jsonb_each(s.details->'perModelRanks') e
                       join _map_chunk mch on mch.old_id = e.key::uuid),
                    '{}'::jsonb))
                  else s.details end`,
      },
      omit: ["id"],
      // The ONE copyRows call that takes a parameter: everything else in this
      // file is scoped by a temp-table join. Postgres rejects a bind that
      // supplies more parameters than the statement names, so the two user ids
      // that other steps carry implicitly are not passed here.
      params: [opts.tunableQuestionIds ?? null],
    });

    // --- 4d. the frozen set --------------------------------------------------
    //
    // THE COMPLEMENT OF THE TWELVE, written down as data so the app never has to
    // ask "is this a guest?" to know what a guest may move (lib/demo/frozen).
    //
    // Phase 4 opens re-scoring and autotune, which were blanket-blocked because
    // the honest objection to them was SIZE, not principle: a re-score retrieves
    // a top-k of chunk text per question, and ~460 questions of that is megabytes
    // per click on a workspace that exists for two hours. Twelve is ~150 KB and
    // an autotune over twelve is dozens of chunk embeds against a 200,000-token
    // budget. So the lever is not turned off, it is pointed at a set the demo can
    // afford — and the set is the SAME twelve that step 4c graded, so the part a
    // visitor can tune is exactly the part whose nDCG they can see move.
    //
    // WHY THE COMPLEMENT RATHER THAN A WHITELIST. `config_question_ignores`
    // already carries the three properties the frozen set needs — out of the
    // rates, out of autotune targeting, still rendered and still scored — and it
    // is the table autotune ALREADY consults. Writing a whitelist instead would
    // mean teaching every one of those readers about a second table, and the
    // failure mode of forgetting one is a guest spending on 460 questions.
    //
    // ON THE PUBLISH HOP this is synthesised, because the master's own ignores
    // are a different fact (a human's "ignore in rates", or 0061's holdout draw)
    // and copying them into a published build would relabel the operator's
    // bookkeeping as the demo's scope. ON THE GUEST HOP it is copied, because by
    // then the snapshot's rows ARE the scope.
    const frozen = opts.tunableQuestionIds
      ? await freezeAllBut(tx, guestId, opts.tunableQuestionIds)
      : await copyRows(tx, {
          table: "config_question_ignores",
          joins: `join _map_config mc on mc.old_id = s.config_id
                  join _map_question mq on mq.old_id = s.eval_question_id`,
          where: `true`,
          overrides: { config_id: "mc.new_id", eval_question_id: "mq.new_id" },
          params: [],
        });

    // --- 4e. the spare wording, so "Add cached" costs nothing ----------------
    //
    // question_cache was on the not-cloned list above until phase 6 of
    // docs/demo-analytics-plan.md, on the reasoning that it "only pays off during
    // question GENERATION, which the demo blocks". That was true of the Add
    // button and never true of ADD CACHED, which is a different lever wearing the
    // same panel: fillChunksFromCache reads the bank, inserts what it finds and
    // calls no model at all. Blocking generation is exactly why this table is
    // worth carrying — it is the only way a guest gets a new question.
    //
    // A HIT IS EXACT AND THEREFORE FREE HERE. 0055 keys on sha256 of the chunk
    // TEXT, and the clone copies chunk text byte for byte, so a guest recomputes
    // the same hash the seed banked under. That is the same property step 6 has
    // to REPAIR for semantic_cache, which keys on document ids: content-addressed
    // caches clone, id-addressed ones need a rewrite.
    //
    // SCOPED THREE WAYS, because the seed's bank spans every corpus and model that
    // account ever generated for and the guest is handed one config over a
    // trimmed corpus.
    //
    //   1. `_hash_scope` — the published chunks' own hashes, so a row for a
    //      passage the guest cannot see is not copied.
    //   2. `llm_model` — wording no config on this build could ever ask for is
    //      dropped (readBanked pins both llm_model and prompt_version).
    //      prompt_version is deliberately NOT filtered: a stale-prompt row is
    //      dead weight the same query already ignores, and pinning today's
    //      fingerprint here would mean a publish silently dropping the bank the
    //      moment someone edits a prompt constant.
    //   3. BANKED_QUESTION_CAP — the one that is a spend limit rather than a
    //      correctness filter, and the reason this step reads as carefully as
    //      step 4d does. A question a guest ADDS is unfrozen by construction
    //      (only a publish writes FROZEN_REASON), so every row copied here is a
    //      row autotune may later run over. Uncapped, the demo's tunable set is
    //      whatever the master happens to have banked — 43 today, unknown after
    //      the master's next generation run, and nothing would report the drift.
    //      Capped, the ceiling is 12 + 12 and it is written down in
    //      lib/demo/frozen.ts next to the other two halves of the same scope.
    //
    // ONE PER PASSAGE, then the cap. `distinct on (text_hash)` spreads the twelve
    // across twelve different chunks rather than stacking four slots onto three,
    // which is what makes them worth something to a visitor: twelve passages to
    // ask about, and twelve distinct chunks for autotune to find an override on.
    // The ordering is arbitrary but STABLE (hash, then difficulty, then slot), so
    // two publishes of an unchanged master carry the same twelve.
    await tx.unsafe(
      `create temp table _hash_scope (text_hash text primary key) on commit drop`,
    );
    for (const table of tables) {
      await tx.unsafe(
        `insert into _hash_scope (text_hash)
         select distinct encode(sha256(convert_to(c."text", 'UTF8')), 'hex')
           from "${table}" c join _map_chunk m on m.old_id = c.id
         on conflict do nothing`,
      );
    }
    const bankedScope = `s.user_id = $1
       and s.llm_model in (
         select c.llm_model from configs c join _map_config mc on mc.old_id = c.id
       )`;
    // What the cap turned away, so the publish can say so out loud rather than
    // leaving "12" to be read as "that is all there was".
    const [{ count: bankedAvailable }] = await tx.unsafe<{ count: number }[]>(
      `select count(distinct s.text_hash)::int as count
         from question_cache s join _hash_scope h on h.text_hash = s.text_hash
        where ${bankedScope}`,
      // $1 only: the census does not rewrite user_id, and a $2 this statement
      // never mentions is a type postgres cannot infer.
      [seedId] as never[],
    );
    const bankedQuestions = await copyRows(tx, {
      table: "question_cache",
      joins: `join _hash_scope h on h.text_hash = s.text_hash`,
      where: bankedScope,
      overrides: { user_id: "$2" },
      dedupe: { on: `s.text_hash`, tieBreak: `s.difficulty, s.slot` },
      limit: BANKED_QUESTION_CAP,
      params: ids,
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
        tieBreak: `s.created_at desc`,
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

    // --- 5b. the shadow log, so the calibration curve has a shape ------------
    //
    // Phase 6.2. The Appraise → Semantic caching page is the app's most
    // distinctive measurement and the demo published it EMPTY, because this table
    // was in neither list above — not copied, and not named as a deliberate
    // omission either.
    //
    // WHAT MAKES THIS DIFFERENT FROM EVERY OTHER COPY HERE: it is the only one
    // that SAMPLES. Everything else takes a set the publish already defines (the
    // config's documents, the baseline generation, the twelve). The shadow log has
    // no natural boundary — it is telemetry that grows every time the operator
    // asks a question — so a copy of "all of it" would mean each guest's disk
    // tracking the master's bookkeeping, which is the same objection step 4e's cap
    // exists for.
    //
    // The sample is stride-taken within each (origin, verdict) stratum, in
    // similarity order. That is not a flourish: the curve IS the accept rate per
    // similarity band, so a sample that skewed either the accept:reject ratio or
    // the sim range would produce a chart that is subtly not the one the operator
    // sees. Striding at one rate per origin keeps both — each stratum contributes
    // its own share, evenly spread across its own range.
    //
    // ONLY ROWS AT OR ABOVE THE SHADOW FLOOR. calibrationCurve drops the sub-floor
    // band by default (it is a ~5% sample sitting next to a census, F5), so those
    // rows would cost a guest disk to change no number on screen.
    await tx.unsafe(
      `create temp table _shadow_pick (
         id uuid primary key,
         judged boolean not null
       ) on commit drop`,
    );

    // THE QUEUE IS RESERVED FIRST, and the order is the point rather than an
    // accident of how this was written. Take the curve sample first and the queue
    // gets whatever the caps happen to leave over — which is twelve rows on
    // today's master (210 probe rows against a cap of 120) and NOTHING the moment
    // the master's probe set drops below the cap. A publish would then ship a
    // stocked-looking curve above an empty queue, i.e. the one control a guest is
    // allowed to touch, silently gone. Reserving first makes the queue depend on
    // the probe set existing at all, not on it being large.
    //
    // Drawn from `probe`: those are the engineered near-misses, so a verdict is a
    // real judgement call rather than an obvious yes. `ntile` rather than the
    // stride below because here the count is exact and small — one row from each
    // of twelve equal slices of the similarity range, so the queue spans easy
    // matches and obvious misses instead of twelve rows that all look alike.
    await tx.unsafe(
      `insert into _shadow_pick (id, judged)
       select distinct on (t.slice) t.id, false
         from (
           select s.id, s.sim, ntile($1::int) over (order by s.sim, s.id) as slice
             from semantic_cache_shadow s
             join _map_config mc on mc.old_id = s.config_id
            where s.origin = 'probe' and s.verdict is not null and s.sim >= $2::real
         ) t
        order by t.slice, t.sim, t.id`,
      [SHADOW_QUEUE_CAP, config.semanticCache.shadowLogFloor] as never[],
    );

    // The curve's own rows, verdicts intact — everything above the floor that the
    // queue did not claim, thinned to the caps.
    await tx.unsafe(
      `insert into _shadow_pick (id, judged)
       select u.id, true
         from (
           select t.*, least(t.cap::numeric / t.tot, 1) as rate
             from (
               select s.id, s.origin,
                      row_number() over (
                        partition by s.origin, s.verdict order by s.sim, s.id
                      ) as rn,
                      count(*) over (partition by s.origin) as tot,
                      (case s.origin when 'probe' then $1::int else $2::int end) as cap
                 from semantic_cache_shadow s
                 join _map_config mc on mc.old_id = s.config_id
                where s.verdict is not null and s.sim >= $3::real
                  and not exists (select 1 from _shadow_pick p where p.id = s.id)
             ) t
         ) u
        -- Bresenham: floor(rn * rate) ticks over once every 1/rate rows, so a
        -- stratum of m rows yields about m*rate picks and they are spread evenly
        -- rather than clustered at either end of the similarity range.
        where floor(u.rn * u.rate) > floor((u.rn - 1) * u.rate)`,
      [SHADOW_CURVE_CAP.probe, SHADOW_CURVE_CAP.traffic, config.semanticCache.shadowLogFloor] as never[],
    );

    // The four judge columns move together or not at all: a row with a verdict but
    // no `judged_at` reads as a bug in the judge rather than as a queue entry.
    const clearIfQueued = (col: string) => `case when p.judged then s."${col}" else null end`;
    const shadowEvents = await copyRows(tx, {
      table: "semantic_cache_shadow",
      joins: `join _map_config mc on mc.old_id = s.config_id
              join _shadow_pick p on p.id = s.id`,
      where: `true`,
      overrides: {
        config_id: "mc.new_id",
        verdict: clearIfQueued("verdict"),
        judge_source: clearIfQueued("judge_source"),
        judge_model: clearIfQueued("judge_model"),
        judge_reason: clearIfQueued("judge_reason"),
        judged_at: clearIfQueued("judged_at"),
      },
      omit: ["id"],
      // Same reason step 5 dedupes, and against the same rewrite: step 6 collapses
      // every fingerprint in a config to one, so two source rows that differed
      // only by corpus signature become one key under 0035's
      // unique (config_id, fingerprint, new_query_hash) and would reject the
      // insert wholesale.
      dedupe: {
        on: `s.config_id, s.new_query_hash`,
        tieBreak: `s.created_at desc`,
      },
      params: [],
    });
    // Counted from what LANDED, not from the pick list: the dedupe above can drop
    // a queue row whose question text also appears in the curve sample, and a
    // publish summary that reported the intent rather than the outcome would be
    // the one number here nobody could check.
    const [{ queued }] = await tx<{ queued: number }[]>`
      select count(*)::int as queued
        from semantic_cache_shadow s
        join configs c on c.id = s.config_id
       where c.user_id = ${guestId} and s.verdict is null
    `;

    // --- 5c. the model comparison, which a guest cannot compute -------------
    //
    // Phase 6.3. Appraise → Models is two rate cards above a full-corpus replay:
    // every embedding model ranking the SAME corpus on the SAME questions, which
    // is the one place the app answers "would a different model do better here".
    // A guest saw the rate cards and a dashed panel.
    //
    // WHY IT COULD NOT SIMPLY BE UNGATED, which is what the plan's bullet assumed.
    // The replay is not a stored measurement, it is a COMPUTATION over
    // embedding_cache — 7,788 cached vectors, 92 MB of wire, measured on the
    // master 2026-08-25 — and it runs on PAGE RENDER. That is the third
    // vector-shipping site in lib/demo/policy's egress list, and it is per visit.
    // Cloning embedding_cache to make it cheap is worse: 107 MB a guest may not
    // re-embed against anyway.
    //
    // So the publish carries the ANSWER instead of the inputs: 17 rows, ~2 KB,
    // under PUBLISHED_REPLAY_FINGERPRINT. That is the sentinel the guest's
    // read-only path (listPublishedReplays) addresses them by, and it is a
    // sentinel rather than the master's own md5 because the real fingerprint
    // hashes the config id and the owner's cache-row count — a copied one is a
    // key nobody in the destination will ever compute, i.e. rows present but
    // unreachable, the exact failure step 6 exists to prevent.
    //
    // UNSCORED ROWS TRAVEL TOO, deliberately. Six of the seventeen models have no
    // cached vectors on the master and land as "0/236 chunks cached". Dropping
    // them would publish a leaderboard of only the models the operator happened to
    // have paid for, with nothing saying so; keeping them is what makes the table
    // read as a real appraisal rather than a curated one.
    //
    // The dedupe is not defensive noise. `writeCached` evicts a config's other
    // fingerprints, so a source normally holds one generation — but the snapshot
    // account is BOTH a destination and the seed guests are cloned from, and
    // opening the page there writes a second (unscorable) generation beside the
    // published one. Preferring the published row keeps a guest cloned from the
    // build rather than from the operator's page visit, and makes the rewrite to a
    // single fingerprint incapable of colliding with itself.
    const replayRows = await copyRows(tx, {
      table: "replay_metrics",
      joins: `join _map_config mc on mc.old_id = s.config_id`,
      where: `true`,
      overrides: {
        config_id: "mc.new_id",
        fingerprint: `'${PUBLISHED_REPLAY_FINGERPRINT}'`,
      },
      dedupe: {
        on: `s.config_id, s.model`,
        tieBreak: `(s.fingerprint = '${PUBLISHED_REPLAY_FINGERPRINT}') desc, s.computed_at desc`,
      },
      params: [],
    });
    // The count that decides whether the tab is worth opening. Seventeen rows of
    // which zero are scored is exactly what the master held before this phase —
    // a stale generation for a config that had since been re-chunked — and it
    // renders as a full table of dashes, which is the failure this step is
    // supposed to have fixed. Counted here so the publish can say so.
    const [{ scored }] = await tx<{ scored: number }[]>`
      select count(*)::int as scored
        from replay_metrics r
        join configs c on c.id = r.config_id
       where c.user_id = ${guestId} and r.mrr is not null
    `;

    // --- 5d. the cache-key sweep, which a guest cannot run either ------------
    //
    // Phase 1 of docs/demo-cache-lab-plan.md, and the same move as 5c one panel
    // over: publish the ANSWER instead of the inputs.
    //
    // WHAT IT BUYS. Appraise → Semantic caching's §4 renders inside `{sweep &&
    // …}`, so a guest gets three disabled buttons and no table — including the
    // PRECISION SLIDER, which costs nothing and never did: it re-derives every
    // row from the curves the sweep already shipped, using the same
    // selectFromCurve the server picks tau with. It is dark only because `sweep`
    // is client state set by a POST a guest may not make. Carrying the row makes
    // the whole control live on page load, with zero requests.
    //
    // WHY IT COULD NOT SIMPLY BE UNGATED. The sweep is ~510 texts under eleven
    // candidate models of real embedding spend, on a guest's cold cache, for
    // models the demo has no key for beyond Voyage. Not affordable and mostly
    // not possible.
    //
    // WHY THIS ONE IS A SINGLE ROW AND NOT A TABLE OF THEM. runKeyModelSweep
    // computes on demand and returns to the response; nothing stores it. So
    // unlike replay_metrics there is nothing here to clone until the publish
    // puts it there — 0077 is that shelf, and scripts/demo-snapshot is the only
    // writer. The whole SweepResult travels as one jsonb, thinned to the 101
    // positions the slider can reach (lib/rag/publishedSweep).
    //
    // The fingerprint is rewritten to the sentinel for exactly 5c's reason: the
    // read path addresses it by that constant, and any other value would be a
    // key nobody in the destination will ever compute.
    const sweepRows = await copyRows(tx, {
      table: "published_sweep",
      joins: `join _map_config mc on mc.old_id = s.config_id`,
      where: `true`,
      overrides: {
        config_id: "mc.new_id",
        fingerprint: `'${PUBLISHED_SWEEP_FINGERPRINT}'`,
      },
      // One row per destination config. A publish carries one config today, but
      // the master may hold a published row under an older fingerprint beside
      // the sentinel one, and the rewrite would collide them on 0077's primary
      // key. Preferring the sentinel keeps a guest cloned from the build.
      dedupe: {
        on: `mc.new_id`,
        tieBreak: `(s.fingerprint = '${PUBLISHED_SWEEP_FINGERPRINT}') desc, s.computed_at desc`,
      },
      params: [],
    });
    // The count that decides whether §4 renders at all — a guest with no row
    // here sees the same three disabled buttons the demo shipped before this
    // phase, which is a working fallback but not the one being published.
    // Counted from what landed, like the shadow queue above.
    const [landed] = await tx<{ models: number }[]>`
      select coalesce(jsonb_array_length(s.result -> 'rows'), 0)::int as models
        from published_sweep s
        join configs c on c.id = s.config_id
       where c.user_id = ${guestId}
       order by s.computed_at desc
       limit 1
    `;
    const sweepModels = landed?.models ?? 0;

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
      // The shadow log carries the SAME validity key (0035 stores the fingerprint
      // at capture time), and it is stale for the same reason. Nothing on the
      // calibration path reads it — the sweep is keyed by space — so a stale value
      // breaks no chart. It breaks recordShadow's `on conflict (config_id,
      // fingerprint, new_query_hash)`: a guest re-asking one of the cloned
      // questions would insert a SECOND row for it instead of colliding with the
      // first, and the demo would slowly double-count its own traffic.
      await tx`
        update semantic_cache_shadow
           set fingerprint = ${fingerprint}
         where config_id = ${cfg.id}
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
      results,
      runs,
      rankings,
      frozen,
      bankedQuestions,
      bankedAvailable,
      cachedAnswers,
      shadowEvents,
      shadowQueued: queued,
      replayRows,
      replayScored: scored,
      sweepRows,
      sweepModels,
    };
  }) as Promise<CloneSummary>;
}
