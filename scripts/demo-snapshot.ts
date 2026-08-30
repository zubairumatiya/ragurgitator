// PUBLISHING THE DEMO — copy one config from the editable master account into
// the frozen account guests are cloned from (docs/demo-snapshot-plan.md).
//
// WHY THIS EXISTS. Guest provisioning clones DEMO_SEED_USER_ID's rows as they are
// at the moment a visitor clicks the button. Point that at the account you work
// in and the account is production: rename a tab, retune top_k, delete a
// document, and the next visitor gets it. Point it at a snapshot instead and the
// two roles separate — an editable master, and a build you publish deliberately.
//
// WHAT IS PUBLISHED IS ONE CONFIG, not an account. `documents` is copied by
// OWNER, so a whole-account copy hands every guest whatever else is sitting in
// the master's library — the off-topic PDFs, the scratch tabs — with no way to
// tell them from corpus content. `--config` (default: the master's leftmost open
// tab) picks the build, and only documents with chunks in it come along.
//
// IT IS A REPLACE, NOT AN APPEND. The destination's previous build is deleted in
// the same transaction as the copy, so re-running republishes rather than
// stacking a second corpus beside the first, and a failure leaves the previous
// build serving guests untouched.
//
//   npm run demo:snapshot -- --create      mint the snapshot account (once)
//   npm run demo:snapshot                  dry run: what would be published
//   npm run demo:snapshot -- --yes         publish
//   … --yes --skip-replay                  publish without warming the model
//                                          comparison (phase 6.3's one deliberate
//                                          92 MB of egress; the build is valid
//                                          without it, that tab just ships stale
//                                          or empty)
//   … --yes --sweep                        RE-run the cache-key sweep even though
//                                          one is already published (it is only
//                                          run automatically when there is none —
//                                          on a cold embedding cache it is ~an
//                                          hour of sequential embedding)
//   … --yes --skip-sweep                   publish without one at all
//
// Env: DEMO_MASTER_USER_ID (the account you work in), DEMO_SNAPSHOT_USER_ID (the
// published one), DEMO_SNAPSHOT_EMAIL (only for --create; must be a real address,
// since password reset is the only way back into that account).
import { withUser } from "../lib/auth/userScope";
import { privilegedSql } from "../lib/db";
import { createSnapshotAccount } from "../lib/demo/admin";
import { cloneSeedWorkspace } from "../lib/demo/clone";
import { BANKED_QUESTION_CAP } from "../lib/demo/frozen";
import { seedPublishedBank, selectBankable } from "../lib/demo/publishedBank";
import {
  QUOTAS,
  selectTunable,
  tunableAnswerCensus,
  tunableCacheKey,
  type Tunable,
} from "../lib/demo/tunable";
import { resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { ndcg } from "../lib/rag/evalMetrics";
import { captureReplayMatrix } from "../lib/demo/captureMatrix";
import { writeBoard, writeMatrix } from "../lib/demo/replay";
import { BOARD_KEY, DEMO_MATRIX_MAX_BYTES, type ReplayBoard } from "../lib/demo/replayCore";
import { runKeyModelSweep } from "../lib/rag/keyModelSweep";
import {
  PUBLISHED_SWEEP_MAX_BYTES,
  publishedForm,
  sweepBytes,
  thinSweep,
  writePublishedSweep,
} from "../lib/rag/publishedSweep";
import { replayConfig } from "../lib/rag/replayStore";
import { scopedAcceptTarget } from "../lib/rag/semanticCache";
import { answerFingerprint } from "../lib/rag/semanticCacheCore";
import { chunksTable, modelDimension } from "../lib/rag/vectorStore";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// Which chunk table a config's vectors live in, or null for a base model that
// has none. Derived per config rather than hardcoded, for the same reason
// clone.ts derives it: the demo is Voyage-only today and a hardcoded table would
// silently report zero the day it is not.
function tableFor(baseModel: string): string | null {
  try {
    return chunksTable(baseModel, modelDimension(baseModel));
  } catch {
    return null;
  }
}

async function chunkCount(configId: string, baseModel: string): Promise<number> {
  const table = tableFor(baseModel);
  if (!table) return 0;
  const [row] = await privilegedSql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from "${table}" where config_id = $1`,
    [configId] as never[],
  );
  return row.n;
}

// IS THE MASTER'S MODEL COMPARISON WARM, and is it warm for THIS config?
//
// Phase 6.3 publishes the replay's result (clone step 5c) because a guest cannot
// compute one. So the build is only as good as what sits in the master's
// replay_metrics at publish time — and the state that motivated the phase was not
// "empty", it was WORSE than empty: one generation, for a config that had since
// been re-chunked, with all seventeen models unscored. Cloned, that is a full
// table of dashes wearing the same layout as a real appraisal.
//
// The check is deliberately NOT the replay's own fingerprint. That is an md5 over
// the chunk texts and the labels, so asking it means reading the corpus back out
// — the egress this whole phase exists to avoid. `corpus_chunks` is the cheap
// proxy that catches the failure that actually happened: a generation computed
// over a different pool than the one being published.
async function replayCensus(configId: string, baseModel: string) {
  const [row] = await privilegedSql<
    { rows: number; scored: number; corpus: number | null; computed: Date | null }[]
  >`
    select count(*)::int as rows, count(mrr)::int as scored,
           max(corpus_chunks) as corpus, max(computed_at) as computed
      from replay_metrics where config_id = ${configId}
  `;
  const table = tableFor(baseModel);
  // Distinct TEXT, not rows: the replay pools by text, since the cache it reads
  // is content-addressed and two identical chunks cannot be told apart.
  const pool = table
    ? (
        await privilegedSql.unsafe<{ n: number }[]>(
          `select count(distinct text)::int as n from "${table}" where config_id = $1`,
          [configId] as never[],
        )
      )[0].n
    : 0;
  return { ...row, pool, warm: row.scored >= 2 && row.corpus === pool };
}

// IS THE CACHE-KEY SWEEP PUBLISHED, and does it hold a table worth rendering?
//
// Phase 1 of docs/demo-cache-lab-plan.md. Unlike every other census here this
// one reads a row THIS SCRIPT wrote: 0077 has no other writer, because
// runKeyModelSweep computes on demand and returns to the response. So "warm"
// means "a previous publish left one", not "the app kept one up to date".
//
// `models` is counted as rows with a non-empty CURVE rather than as rows, and
// that is the number that decides whether the phase worked. A leaderboard row
// with no curve renders as a dash and, more to the point, gives the precision
// slider nothing to re-derive — and the slider is the entire reason this row is
// published.
async function sweepCensus(configId: string) {
  const [row] = await privilegedSql<
    { models: number; bytes: number; pairs: number | null; computed: Date | null }[]
  >`
    select
      (select count(*) from jsonb_array_elements(s.result -> 'rows') r
        where jsonb_array_length(coalesce(r -> 'calibration' -> 'curve', '[]'::jsonb)) > 0)::int
        as models,
      octet_length(s.result::text) as bytes,
      (s.result -> 'pairs' ->> 'total')::int as pairs,
      s.computed_at as computed
    from published_sweep s
    where s.config_id = ${configId}
    order by s.computed_at desc
    limit 1
  `;
  if (!row) return { models: 0, bytes: 0, pairs: null, computed: null, warm: false };
  // Two scored models is the same bar the replay census uses, and for the same
  // reason: one row is not a comparison.
  return { ...row, warm: row.models >= 2 };
}

// WHAT WOULD BE PUBLISHED — measured through the config, which is what makes it
// a preview of the copy rather than a description of the master account. The
// document count in particular is the one the filter changes: the master holds
// nine, this reports the six that have vectors in the tab being published.
async function sourceCensus(configId: string, baseModel: string) {
  const table = tableFor(baseModel);
  const documents = table
    ? (
        await privilegedSql.unsafe<{ n: number }[]>(
          `select count(distinct document_id)::int as n from "${table}" where config_id = $1`,
          [configId] as never[],
        )
      )[0].n
    : 0;
  const [{ n: cached }] = await privilegedSql<{ n: number }[]>`
    select count(*)::int as n from semantic_cache where config_id = ${configId}
  `;
  // Counted two ways because the clone copies only the LABELED ones. A question
  // whose label resolves under a different config's chunking arrives with no
  // ground truth and can never be scored here, so it is not published — and a dry
  // run that promised 554 and delivered 472 would read as a bug in the filter.
  const [{ n: questions, labeled }] = table
    ? await privilegedSql.unsafe<{ n: number; labeled: number }[]>(
        `select count(*)::int as n,
                count(*) filter (where exists (
                  select 1 from eval_labels l
                    join document_embeddings de on de.id = l.document_embedding_id
                   where l.eval_question_id = q.id and de.config_id = $1))::int as labeled
           from eval_questions q
          where q.document_id in (select distinct document_id from "${table}" where config_id = $1)`,
        [configId] as never[],
      )
    : [{ n: 0, labeled: 0 }];
  const [{ n: scores }] = await privilegedSql<{ n: number }[]>`
    select count(distinct (r.eval_label_id, r.k))::int as n
      from eval_results r
      join eval_labels l on l.id = r.eval_label_id
      join document_embeddings de on de.id = l.document_embedding_id
     where de.config_id = ${configId}
       and r.retrieval_state = 'baseline' and not r.is_baseline
  `;
  return {
    documents,
    chunks: await chunkCount(configId, baseModel),
    cached,
    questions,
    labeled,
    scores,
  };
}

// WHAT WOULD BE DESTROYED — the destination account as a whole, deliberately:
// the publish replaces the entire workspace, not just the tab of the same name,
// so an operator about to type --yes should see the whole of what goes.
async function destCensus(userId: string) {
  const cfgs = await privilegedSql<{ id: string; base_model: string }[]>`
    select id, base_model from configs where user_id = ${userId}
  `;
  let chunks = 0;
  for (const c of cfgs) chunks += await chunkCount(c.id, c.base_model);
  const [row] = await privilegedSql<{ documents: number; cached: number }[]>`
    select (select count(*) from documents where user_id = ${userId})::int as documents,
           (select count(*) from semantic_cache where user_id = ${userId})::int as cached
  `;
  return { configs: cfgs.length, chunks, ...row };
}

// THE CHECK THAT MATTERS AFTER A PUBLISH. semantic_cache rows are found by
// `fingerprint`, which hashes the config's DOCUMENT IDS; the copy mints new ones
// and rewrites the fingerprint to match (clone.ts step 6). If that ever stopped
// happening the rows would still be there, still counted, and permanently
// unreachable — a demo with no answer key and nothing in the logs to say so. So
// recompute the fingerprint from the published rows and compare.
async function verifyFingerprints(userId: string): Promise<boolean> {
  const cfgs = await privilegedSql<
    { id: string; name: string; base_model: string; cascade_enabled: boolean }[]
  >`select id, name, base_model, cascade_enabled from configs where user_id = ${userId}`;

  let ok = true;
  for (const cfg of cfgs) {
    let table: string;
    try {
      table = chunksTable(cfg.base_model, modelDimension(cfg.base_model));
    } catch {
      continue;
    }
    const [sig] = await privilegedSql.unsafe<{ docs: string }[]>(
      `select coalesce(md5(string_agg(distinct document_id::text, ',' order by document_id::text)),
                       'empty') as docs
         from "${table}" where config_id = $1`,
      [cfg.id] as never[],
    );
    const expected = answerFingerprint({
      cascadeEnabled: cfg.cascade_enabled,
      documents: sig.docs,
    });
    const [row] = await privilegedSql<{ total: number; reachable: number }[]>`
      select count(*)::int as total,
             count(*) filter (where fingerprint = ${expected})::int as reachable
        from semantic_cache where user_id = ${userId} and config_id = ${cfg.id}
    `;
    const good = row.total === row.reachable;
    ok &&= good;
    console.log(
      `  ${good ? "✔" : "✗"} ${cfg.name}: ${row.reachable}/${row.total} cached answers reachable`,
    );
  }
  return ok;
}

// File names for the composition line, keyed by document id. Read here rather
// than joined into selectTunable because the selection is shared with
// demo-warm-answers.ts, which has no use for a name it would only be paying to
// carry.
async function documentNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await privilegedSql<{ id: string; file_name: string }[]>`
    select id::text as id, file_name from documents where id = any(${ids}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id, r.file_name]));
}

// REFUSE A DULL BUILD. The set drifts on purpose, so the failure mode is not a
// crash — it is a publish that quietly hands every visitor a board of rank-1
// questions, an autotune button with nothing to search, and a drilldown that shows
// one identical perfect ordering after another. That is a worse demo than the one
// this replaces, and it would ship without a single error.
//
// The bars are deliberately below the quota: the quota is what we ask for, this is
// what the demo cannot do without. They are FRACTIONS OF QUOTAS rather than the
// constants they used to be, because the set widened from 12 to 30 (§2) and a
// hand-written floor of 8 would have let a build a third of the intended size walk
// straight past the guard that exists to stop it.
function assertSpread(picked: Tunable[]): void {
  const want = QUOTAS.reduce((n, q) => n + q.n, 0);
  const quota = (tier: number) => QUOTAS.find((q) => q.tier === tier)?.n ?? 0;
  const twoThirds = Math.ceil((want * 2) / 3);

  const misses = picked.filter((p) => p.tier === 99).length;
  const tail = picked.filter((p) => p.tier >= 3).length; // rank 3+ or missed
  const easy = picked.filter((p) => p.tier === 1).length;
  const chunks = new Set(picked.map((p) => p.chunk)).size;
  const docs = new Set(picked.map((p) => p.document)).size;

  const problems: string[] = [];
  if (picked.length < twoThirds)
    problems.push(`only ${picked.length} tunable questions (want ${want})`);
  if (misses < Math.ceil(quota(99) / 2))
    problems.push(`only ${misses} missed question(s) — autotune needs failures`);
  if (tail < Math.ceil((quota(99) + quota(4) + quota(3)) / 2))
    problems.push(`only ${tail} in the hard tail (rank 3+ or missed)`);
  if (easy < 1) problems.push("no rank-1 question — nothing to show a working retrieval against");
  if (chunks < twoThirds) problems.push(`only ${chunks} distinct chunks — autotune reshapes chunks`);
  // FOUR OF THE SIX, not two. §2 measured one document's board and found it flat
  // before anything was even scoped to it — 51 of 60 questions already at rank 1 —
  // so a set that collapsed onto one or two files would argue against the product
  // it is demonstrating. Four rather than all six because rank 3 and rank 4 each
  // span only three documents on the master today; requiring six would make the
  // publish hostage to a tier that may only exist in two files next month.
  if (docs < 4) problems.push(`only ${docs} document(s) — a one-document board is already flat`);
  if (problems.length > 0) {
    die(
      `the tunable set has no spread, so the published demo would have a dead autotune button:\n` +
        problems.map((p) => `    - ${p}`).join("\n") +
        `\n\n  The master's scores have moved. Re-check the found_rank distribution for the\n` +
        `  config being published before forcing this through.`,
    );
  }
}

// MAKE THE AUTOTUNE BUTTON ABLE TO FIND ITS TARGETS.
//
// Phase 4 hands a guest a real autotune run over the twelve. Two settings on the
// published config can quietly make that run a no-op, and both are settings the
// operator set for their OWN work on the master, months ago, for reasons that
// have nothing to do with the demo:
//
//   autotune_chunk_scope (0025) — a non-null list restricts a run to those chunks.
//     The master's is a two-chunk experiment. The twelve deliberately span eight
//     or more chunks (selectTunable picks one question per chunk), so a scope set
//     for something else will almost never intersect them, and the button would
//     search nothing and report success. CLEARED, because the frozen set is now
//     the scope and two mechanisms narrowing the same run is one too many.
//
//   the min-rates — prepareAutotune refuses outright ("Set a min-rate on an
//     enabled metric in Settings") when no enabled metric carries one. That is a
//     legible refusal rather than a silent no-op, so it is reported, not fixed:
//     which bar the demo should tune against is an editorial choice, and guessing
//     one here would publish a number nobody chose.
//
// Also reported: a holdout draw left enabled would write its own ignores over the
// twelve on the guest's first settings save, shrinking the live set again for a
// measurement the demo has no room to take.
async function armAutotune(snapshot: string): Promise<void> {
  const [cfg] = await privilegedSql<
    {
      id: string;
      autotune_chunk_scope: string[] | null;
      recall_enabled: boolean;
      recall_min_rate: number | null;
      mrr_enabled: boolean;
      mrr_min_rate: number | null;
      ndcg_enabled: boolean;
      ndcg_min_rate: number | null;
      autotune_holdout_enabled: boolean;
    }[]
  >`
    select id, autotune_chunk_scope, recall_enabled, recall_min_rate, mrr_enabled,
           mrr_min_rate, ndcg_enabled, ndcg_min_rate, autotune_holdout_enabled
      from configs where user_id = ${snapshot}
  `;
  if (!cfg) throw new Error("arm: the snapshot holds no config after publishing");

  if (cfg.autotune_chunk_scope !== null) {
    await privilegedSql`
      update configs set autotune_chunk_scope = null where id = ${cfg.id}
    `;
    console.log(
      `cleared the published config's autotune chunk scope ` +
        `(${cfg.autotune_chunk_scope.length} chunk(s) — the master's, not the demo's)`,
    );
  }

  const bars = [
    cfg.recall_enabled && cfg.recall_min_rate !== null ? "recall" : null,
    cfg.mrr_enabled && cfg.mrr_min_rate !== null ? "MRR" : null,
    // Gradable for the twelve and only the twelve: nDCG needs an is_truth
    // ranking, which is exactly what step 4c copied. No LLM is involved — the
    // ideal ordering is already stored.
    cfg.ndcg_enabled && cfg.ndcg_min_rate !== null ? "nDCG" : null,
  ].filter(Boolean);
  if (bars.length === 0) {
    console.log(
      `⚠ no enabled metric on the published config carries a min-rate, so a guest's\n` +
        `  autotune will refuse before it searches. Set one in Settings on the master\n` +
        `  and re-publish.\n`,
    );
  } else {
    console.log(`autotune targets: ${bars.join(", ")}`);
  }

  if (cfg.autotune_holdout_enabled) {
    console.log(
      `⚠ the published config has the holdout draw enabled. It writes its own ignores,\n` +
        `  so a guest's first settings save would hold back part of an already tiny\n` +
        `  tunable set. Turn it off on the master and re-publish.\n`,
    );
  }
}

// THE "AS PUBLISHED" NUMBER, measured over what was actually published.
//
// The analytics plan assumed this card could just read the newest `eval_runs` row,
// on the grounds that it "is a row that already exists". It is not — checked
// against live 2026-08-23:
//
//   - eval_runs carries no retrieval_state column, so a run measured WITH the
//     master's 274 chunk overrides is indistinguishable from one measured without
//     them. There is no filter that selects the honest row.
//   - Every one of this config's 33 rows is either the tuned state (99.2% recall,
//     468/472) or a 354-question corpus from an earlier chunking. None of them
//     matches the generation a guest actually gets, which is 444/472.
//
// Shipping the newest row would print "468 hits" above a question list showing 444,
// with 28 misses visible underneath a card claiming 4. So the row is COMPUTED here,
// over the scores the clone just copied, and it replaces the master's history
// wholesale rather than sitting on top of it — a run panel offering a 99.2% result
// the guest can never reproduce is the same lie in a smaller font.
//
// nDCG IS MEASURED FROM THE SNAPSHOT'S OWN ROWS, AFTER THE COPY — not from the
// master's. That is a deliberate second job: the graded score is
// ndcg(chunk_ids, retrieved_ids, k) over two uuid arrays that clone.ts rewrote
// element-wise into a fresh id space (steps 4b and 4c). Compute it here and a
// remap that silently failed shows up as a frozen nDCG of 0.000 in the publish
// output, in front of the operator, rather than as a quietly flat metric on a
// visitor's dashboard.
//
// Its denominator is the TWELVE, not the 472 beside it — see 0076 and the
// ndcg_covered column, which is what stops the card claiming otherwise.
async function freezePublishedRun(snapshot: string, copied: number): Promise<void> {
  const [cfg] = await privilegedSql<
    { id: string; base_model: string; chunk_size: number; chunk_overlap: number }[]
  >`
    select id, base_model, chunk_size, chunk_overlap
      from configs where user_id = ${snapshot}
  `;
  if (!cfg) throw new Error("freeze: the snapshot holds no config after publishing");

  // Aggregated the way evalStore does it: MRR is reciprocalRank(found_rank, k) —
  // zero on a miss AND on a rank beyond k — averaged over every scored question.
  const [agg] = await privilegedSql<
    { k: number; questions: number; hits: number; mrr: number | null }[]
  >`
    select r.k,
           count(*)::int as questions,
           count(*) filter (where r.hit)::int as hits,
           avg(case when r.found_rank is not null and r.found_rank <= r.k
                    then 1.0 / r.found_rank else 0 end)::real as mrr
      from eval_results r
      join eval_questions q on q.id = r.eval_question_id
      join documents d on d.id = q.document_id
     where d.user_id = ${snapshot}
     group by r.k
     order by count(*) desc
     limit 1
  `;
  if (!agg) {
    console.log("⚠ no scores were published — the Eval tab's \"As published\" card will be empty\n");
    return;
  }

  // The graded pairs, as published. Both arrays are small (k ids and a 30-chunk
  // ideal), and there are twelve of them, so this is the one place in a publish
  // that reads row bodies back — a few KB against clone.ts's zero-egress rule,
  // which is a rule about the per-guest path, not about the operator's own run.
  const graded = await privilegedSql<{ ideal: string[]; retrieved: string[] }[]>`
    select rk.chunk_ids as ideal, res.retrieved_ids as retrieved
      from eval_rankings rk
      join eval_questions q on q.id = rk.eval_question_id
      join documents d on d.id = q.document_id
      join eval_labels l on l.eval_question_id = q.id
                        and l.document_embedding_id = rk.document_embedding_id
      join eval_results res on res.eval_label_id = l.id and res.k = ${agg.k}
     where d.user_id = ${snapshot} and rk.is_truth
  `;
  // Same call evalStore's per-question nDCG makes, at the run's own k. Every
  // metric k on this config is unset and therefore top_k (A1), so the run's
  // single k labels all three cards honestly; the day nDCG gets its own k, this
  // row can no longer carry all three and the card has to split.
  // ndcg() returns null for an ideal with no gain — an empty chunk_ids, i.e. a
  // truth row whose ids all failed to map. Dropped rather than counted as zero:
  // that question is UNGRADED, and averaging a null in as 0 would blame the
  // corpus for a copy that did not happen. The count below is what says so.
  const scores = graded
    .map((g) => ndcg(g.ideal, g.retrieved ?? [], agg.k))
    .filter((v): v is number => v !== null);
  const meanNdcg =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  await privilegedSql.begin(async (tx) => {
    await tx`delete from eval_runs where config_id = ${cfg.id}`;
    await tx`
      insert into eval_runs
        (config_id, model, chunk_size, chunk_overlap, k, question_count, hit_count, mrr, ndcg,
         ndcg_covered, notes)
      values
        (${cfg.id}, ${cfg.base_model}, ${cfg.chunk_size}, ${cfg.chunk_overlap}, ${agg.k},
         ${agg.questions}, ${agg.hits}, ${agg.mrr}, ${meanNdcg},
         ${scores.length > 0 ? scores.length : null}, 'as published')
    `;
  });

  const recall = ((100 * agg.hits) / agg.questions).toFixed(1);
  console.log(
    `frozen baseline: ${agg.hits}/${agg.questions} at k=${agg.k} — recall ${recall}%, ` +
      `MRR ${agg.mrr?.toFixed(3) ?? "—"}, ` +
      `nDCG ${meanNdcg?.toFixed(3) ?? "—"} over ${scores.length} graded\n` +
      `  (replaced ${copied} run snapshot${copied === 1 ? "" : "s"} copied from the master)\n`,
  );
  if (scores.length > 0 && meanNdcg === 0) {
    console.log(
      "⚠ every graded question scored nDCG 0. That is not a bad corpus, it is a broken\n" +
        "  id remap: the ideal order and the retrieved order are in different id spaces.\n",
    );
  }
}

async function main() {
  const master = process.env.DEMO_MASTER_USER_ID?.trim();
  if (!master) {
    die(
      "DEMO_MASTER_USER_ID is not set. It is the account you WORK IN — the one " +
        "DEMO_SEED_USER_ID pointed at before snapshots existed.",
    );
  }

  // --create is its own run and stops there, on purpose: the id it mints has to
  // be written into .env.local before anything can publish into it, and doing
  // both in one pass would leave the operator with a published account whose id
  // exists only in a terminal that has scrolled away.
  if (has("--create")) {
    const email = process.env.DEMO_SNAPSHOT_EMAIL?.trim();
    if (!email) die("DEMO_SNAPSHOT_EMAIL is not set (use a real address — see the header).");
    if (email.endsWith("@demo.invalid")) {
      die("DEMO_SNAPSHOT_EMAIL must be deliverable: password reset is the only way back in.");
    }
    const password = crypto.randomUUID() + crypto.randomUUID();
    const id = await createSnapshotAccount(email, password);
    console.log(`\n✔ snapshot account created: ${email}\n`);
    console.log(`  DEMO_SNAPSHOT_USER_ID=${id}\n`);
    console.log(`  password (shown once, or reset it by email later):\n  ${password}\n`);
    console.log("Add the id to .env.local, then re-run without --create.\n");
    return;
  }

  const snapshot = process.env.DEMO_SNAPSHOT_USER_ID?.trim();
  if (!snapshot) die("DEMO_SNAPSHOT_USER_ID is not set. Run with --create to mint the account.");
  if (snapshot === master) die("DEMO_SNAPSHOT_USER_ID and DEMO_MASTER_USER_ID are the same account.");

  // A guest expires and is reaped; publishing into one would delete the build
  // out from under the demo within the TTL.
  const [profile] = await privilegedSql<{ email: string; is_guest: boolean }[]>`
    select email, is_guest from user_profiles where id = ${snapshot}
  `;
  if (!profile) die(`no account ${snapshot}. Run with --create, or fix DEMO_SNAPSHOT_USER_ID.`);
  if (profile.is_guest) die(`${profile.email} is a GUEST account — it expires. Mint an ordinary one.`);

  const configId =
    valueOf("--config") ??
    (
      await privilegedSql<{ id: string }[]>`
        select id from configs where user_id = ${master} and is_open
         order by tab_order, created_at limit 1
      `
    )[0]?.id;
  if (!configId) die("the master account has no open config to publish (pass --config <uuid>).");

  const [cfg] = await privilegedSql<{ name: string; base_model: string; top_k: number }[]>`
    select name, base_model, top_k from configs where id = ${configId} and user_id = ${master}
  `;
  if (!cfg) die(`config ${configId} is not owned by the master account.`);

  const from = await sourceCensus(configId, cfg.base_model);
  const to = await destCensus(snapshot);
  const tunable = await selectTunable(configId);
  const replay = await replayCensus(configId, cfg.base_model);
  const sweep = await sweepCensus(configId);

  console.log(`\nmaster    ${master}`);
  console.log(`snapshot  ${snapshot}  (${profile.email})\n`);
  console.log(`publishing "${cfg.name}" (${cfg.base_model})`);
  console.log(
    `  ${from.documents} documents, ${from.chunks} chunks, ` +
      `${from.labeled} questions${
        from.labeled === from.questions ? "" : ` (of ${from.questions} — the rest carry no label here)`
      }, ${from.scores} published scores, ${from.cached} cached answers`,
  );
  // The composition, not just the count: the size of the set is the uninteresting
  // half of this number and the spread is the half that decides whether the demo
  // has a working autotune button.
  const tiers = QUOTAS.map((q) => {
    const n = tunable.filter((t) => t.tier === q.tier).length;
    return n > 0 ? `${n} ${q.label}` : null;
  }).filter(Boolean);
  console.log(
    `  ${tunable.length} of them graded for nDCG (${tiers.join(", ")}), over ` +
      `${new Set(tunable.map((t) => t.chunk)).size} chunks in ` +
      `${new Set(tunable.map((t) => t.document)).size} documents`,
  );
  // AND THE PER-DOCUMENT SHARE, spelled out. The document count above says six
  // without saying that five of the thirty are in one file and one is in each of
  // the rest — and the document filter narrows WITHIN the board (§2), so a
  // document holding one question is a filter that lands a visitor on an
  // almost-empty board. Nothing else in the publish shows this.
  const perDoc = await documentNames([...new Set(tunable.map((t) => t.document))]);
  const share = [...perDoc.entries()]
    .map(([id, name]) => ({ name, n: tunable.filter((t) => t.document === id).length }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  console.log(`    ${share.map((d) => `${d.name} ${d.n}`).join(" · ")}`);
  // CAN A GUEST ACTUALLY ASK THE TWELVE? A guest carries a Voyage key and no
  // answer-model key, so a tunable question with no banked answer under the
  // lookup's exact key is a dead end (/api/chat → DEMO_BLOCKED). The total on the
  // line above reads as plenty — 252 answers — while the twelve that the chips,
  // the drilldown and the autotune button all point at can be uncovered, and
  // until this line existed nothing said so.
  //
  // Reported before the dry-run exit, and named individually, because the fix is
  // a SPEND on the master (`npm run demo:warm`) that has to happen before the
  // publish rather than after it.
  const answers = await tunableAnswerCensus(configId, tunable);
  const dead = answers.filter((a) => !a.cached);
  const key = await tunableCacheKey(configId);
  console.log(
    `  ${answers.length - dead.length}/${answers.length} of them have a banked answer` +
      (key === null ? "" : ` (${key.keyModel} / ${key.llmModel} / ${key.fingerprint.slice(0, 12)}…)`),
  );
  if (dead.length > 0) {
    console.log(
      `\n⚠ ${dead.length} tunable question(s) have NO banked answer — a guest asking one\n` +
        `  gets "the demo has no answer-model key" and nothing else:\n` +
        dead.map((d) => `    - ${d.question}`).join("\n") +
        `\n\n  Run \`npm run demo:warm\` on the master to buy them, then re-publish.\n`,
    );
  }
  // The model comparison, before the dry-run exit for the same reason the spread
  // assertion is: an operator deciding whether to publish should see that this
  // run is about to spend 92 MB warming it, or that it is about to publish a
  // table of dashes, without having to type --yes to find out.
  console.log(
    `  model comparison: ${
      replay.warm
        ? `${replay.scored}/${replay.rows} models scored over ${replay.corpus} chunks, ` +
          `computed ${replay.computed?.toISOString().slice(0, 10)}`
        : replay.rows === 0
          ? "never run for this config"
          : `stale — ${replay.scored}/${replay.rows} scored over ${replay.corpus} chunks, ` +
            `but this config pools ${replay.pool}`
    }${replay.warm || has("--skip-replay") ? "" : " → will be computed before the copy (~92 MB)"}`,
  );
  // The cache-key sweep, on the same terms and before the same exit. Its cost is
  // the one number an operator most needs in advance: on a warm embedding cache a
  // re-run is minutes, on a cold one it is ~an hour of sequential embedding, and
  // nothing on screen distinguishes those two until it is running.
  const willSweep = !has("--skip-sweep") && (has("--sweep") || !sweep.warm);
  console.log(
    `  cache-key sweep: ${
      sweep.warm
        ? `${sweep.models} models with curves over ${sweep.pairs ?? "?"} pairs, ` +
          `${(sweep.bytes / 1024).toFixed(0)} KB, computed ` +
          `${sweep.computed?.toISOString().slice(0, 10)}`
        : sweep.computed === null
          ? "never published for this config"
          : `published but only ${sweep.models} models carry a curve`
    }${willSweep ? " → will be run before the copy (embedding spend)" : ""}`,
  );

  // Before the dry-run exit, so an operator sees the refusal without having to
  // type --yes to earn it.
  assertSpread(tunable);

  console.log(`\nreplacing the snapshot's current build`);
  console.log(
    `  ${to.configs} configs, ${to.documents} documents, ${to.chunks} chunks, ` +
      `${to.cached} cached answers\n`,
  );

  if (!has("--yes")) {
    console.log("Dry run. Re-run with --yes to publish.\n");
    return;
  }

  if (from.cached === 0) {
    console.log("⚠ the config being published has NO cached answers — guests will pay for every\n");
  }

  // WARM THE MODEL COMPARISON, ON THE MASTER, ONCE (phase 6.3).
  //
  // This is the only place in the publish that deliberately spends egress: ~92 MB
  // of cached vectors for 11 covered models over 236 chunks and 472 questions,
  // measured 2026-08-25. It buys the thing a guest cannot compute — and it buys
  // it ONCE PER PUBLISH rather than once per visitor, which is the whole trade.
  //
  // It runs BEFORE the clone and in the master's own scope, because replayConfig
  // is an ordinary user-scoped store call: it reads the master's embedding_cache
  // and writes the master's replay_metrics, exactly as opening the page would.
  // Step 5c then copies whatever is there. Doing it the other way round — copy
  // first, warm after — would publish the previous build's numbers and report the
  // new ones.
  //
  // Skipped when already warm, so a re-publish costs nothing. `--skip-replay` is
  // for a metered connection: the build is still valid, it just ships the
  // previous generation, or the empty state if there is none.
  if (!replay.warm && !has("--skip-replay")) {
    const [me] = await privilegedSql<{ email: string }[]>`
      select email from user_profiles where id = ${master}
    `;
    if (!me) die(`no user_profiles row for the master account ${master}.`);
    console.log("computing the model comparison on the master (~92 MB of cached vectors)…");
    const started = Date.now();
    const report = await withUser({ id: master, email: me.email }, () =>
      replayConfig(configId, cfg.base_model, cfg.name, cfg.top_k),
    );
    const scored = report.rows.filter((r) => r.mrr !== null).length;
    console.log(
      `  ${scored}/${report.rows.length} models scored over ${report.corpusChunks} chunks ` +
        `and ${report.questions} questions in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
  }

  // RUN THE CACHE-KEY SWEEP ON THE MASTER, AND SHELVE IT (phase 1 of
  // docs/demo-cache-lab-plan.md).
  //
  // The second place the publish deliberately spends, and the first that spends
  // on a PROVIDER rather than on egress: every pooled pair text embedded under
  // every candidate model. It buys the thing a guest cannot buy — §4's
  // leaderboard, and with it the precision slider, which re-derives every row
  // client-side from the curves this produces and therefore costs a visitor
  // nothing at all.
  //
  // Like the replay above it runs in the MASTER's own scope, before the clone,
  // because runKeyModelSweep is an ordinary user- and config-scoped call: the
  // pooled pair set is the master's, and scopedAcceptTarget reads the config's
  // stored precision target. Step 5d then copies whatever is on the shelf.
  //
  // NOT re-run when one is already published, unlike the replay's "warm" check
  // which is about staleness. Here it is about cost: embedQueryCached makes a
  // re-run nearly free ONLY once every text is banked, and the first run on a
  // cold cache is ~an hour. `--sweep` forces it when the pair set has moved.
  if (willSweep) {
    const [me] = await privilegedSql<{ email: string }[]>`
      select email from user_profiles where id = ${master}
    `;
    if (!me) die(`no user_profiles row for the master account ${master}.`);
    console.log("running the cache-key sweep on the master (embedding spend)…");
    const started = Date.now();
    const result = await withUser({ id: master, email: me.email }, async () => {
      const scoped = await resolveConfig(configId);
      if (!scoped) die(`config ${configId} did not resolve in the master's scope.`);
      return withConfig(scoped, async () => {
        // THE MATRIX FIRST, then the published sweep — phase 2 of
        // docs/demo-cache-replay-plan.md, and the order is the cost argument.
        // This run pools the quarantined pairs as well, so it is the one that
        // buys their vectors; every text the published sweep then needs is
        // already banked and content-addressed, so it runs warm. Reverse the two
        // and the operator pays the cold-cache hour twice.
        const capture = await captureReplayMatrix(await scopedAcceptTarget());
        await writeMatrix(master, capture.matrix);
        console.log(
          `  banked a ${capture.matrix.pairs.length}×${capture.matrix.models.length} similarity matrix ` +
            `(${capture.scoredModels} models scored, ${capture.quarantined} pairs quarantined) ` +
            `at ${(capture.bytes / 1024).toFixed(0)} KB`,
        );
        // Soft, and reported for PUBLISHED_SWEEP_MAX_BYTES' reason exactly: the
        // matrix rides in a guest's first payload, so the alternative to
        // noticing here is noticing on a visitor's connection.
        if (capture.bytes > DEMO_MATRIX_MAX_BYTES) {
          console.log(
            `⚠ the replay matrix is ${(capture.bytes / 1024).toFixed(0)} KB, over the ` +
              `${(DEMO_MATRIX_MAX_BYTES / 1024).toFixed(0)} KB this is meant to stay under.`,
          );
        }
        const out = await runKeyModelSweep(await scopedAcceptTarget());
        await writePublishedSweep(configId, out);
        return out;
      });
    });
    const withCurves = result.rows.filter((r) => (r.calibration?.curve.length ?? 0) > 0).length;
    // Raw vs thinned, reported rather than assumed — the plan's own sizing was
    // out by 10x (it sketched ~50 KB for what measures ~500), and this is the
    // number that decides whether the published row is something to hand out on
    // page load at all.
    const raw = sweepBytes(result);
    const thin = sweepBytes(thinSweep(result));
    // What is actually STORED, and therefore what every panel mount re-reads
    // over the hop Supabase bills — thinning answered the page-load question,
    // packing answers this one (phase 1.5).
    const stored = sweepBytes(publishedForm(result));
    console.log(
      `  ${withCurves}/${result.rows.length} models with curves over ${result.pairs.total} pairs ` +
        `in ${((Date.now() - started) / 1000).toFixed(0)}s — ` +
        `${(raw / 1024).toFixed(0)} KB thinned to ${(thin / 1024).toFixed(0)} KB, ` +
        `stored packed at ${(stored / 1024).toFixed(0)} KB` +
        `${result.cancelled ? " (CANCELLED — partial)" : ""}\n`,
    );
    if (stored > PUBLISHED_SWEEP_MAX_BYTES) {
      console.log(
        `⚠ the published sweep is ${(stored / 1024).toFixed(0)} KB, over the ` +
          `${(PUBLISHED_SWEEP_MAX_BYTES / 1024).toFixed(0)} KB this is meant to stay under.\n` +
          "  It is still valid and the build still works — but it rides in the panel's first\n" +
          "  payload, so at this size fetching it on demand starts to beat handing it out.\n",
      );
    }
  }

  // THE BOARD THE EVAL TAB IS SCOPED TO (phase 2 of docs/demo-real-flow-plan.md).
  //
  // Written on the MASTER, before the clone, for the same reason the matrix above
  // is: these are the master's chunk ids, and clone step 5g is the one thing that
  // knows how to rewrite an id into the destination's space. Written on every
  // publish rather than under a flag — unlike the matrix it costs nothing to
  // capture, and a build without one is a build whose demo has no scope.
  //
  // THE SAME CHUNKS THE TUNABLE SET SITS ON, deliberately: the board is what
  // selectTunable already chose, promoted from an implication of the frozen set
  // into a fact of its own. Today those two agree by construction; phase 4 empties
  // the questions and this row is what survives that.
  //
  // Order is the selector's (tier desc, md5) and no reader depends on it —
  // getSummary orders the chunk list by document and position, as it does for
  // every account. It is banked as given so a re-publish of an unchanged build
  // produces an identical payload rather than a reshuffled one.
  // Through privilegedSql, like every other publish-time write in this script
  // (seedPublishedBank, armAutotune): a script has no request scope, so the
  // request-scoped `sql` writeBoard defaults to would throw before it wrote. The
  // matrix above avoids this by running inside the sweep's own withUser block.
  await writeBoard(
    master,
    { version: 1, chunks: [...new Set(tunable.map((t) => t.chunk))] },
    privilegedSql,
  );

  const summary = await cloneSeedWorkspace(master, snapshot, {
    onlyConfigId: configId,
    replaceDestination: true,
    tunableQuestionIds: tunable.map((t) => t.id),
  });

  // THE "AS PUBLISHED" CARD, MEASURED BEFORE THE BUILD IS EMPTIED.
  //
  // Moved above the bank by §3.2, and the order is now load-bearing rather than
  // incidental: this reads the copied eval_results and eval_rankings back to
  // compute the headline, and the next step deletes every one of them. Run it
  // afterwards and it finds nothing and prints "no scores were published" over a
  // build that published 460 of them. Copy, then CORRECT, then empty.
  await freezePublishedRun(snapshot, summary.runs);

  // THE QUESTIONS "ADD CACHED" WILL HAND OUT — WHICH IS NOW THE WHOLE BOARD
  // (docs/demo-question-bank-plan.md, re-cut by §3.2 of the real-flow plan).
  //
  // Runs on the SNAPSHOT, after the copy, because that is where both things it
  // reads are already written down: the board scope as the demo_replay row step
  // 5g remapped, and the questions as the rows the clone just minted. It replaces
  // the bank the clone inherited from the master with sixty chosen ones and then
  // DELETES EVERY QUESTION IN THE BUILD — see lib/demo/publishedBank.ts for why
  // both halves, and why the delete is total rather than the picks.
  //
  // Nothing on the master changes, so a publish is still a copy: this only edits
  // the account it just wrote.
  const [snapCfg] = await privilegedSql<{ id: string; llm_model: string }[]>`
    select id, llm_model from configs where user_id = ${snapshot} limit 1
  `;
  if (!snapCfg) die(`the publish wrote no config into ${snapshot}.`);
  // The board in the SNAPSHOT's id space. Read back rather than derived from
  // `tunable` above, whose ids are the master's: this is the same row a guest's
  // getSummary will scope on, so a remap that dropped ids shows up here as a
  // short bank in front of the operator rather than as a half-empty board in a
  // visitor's browser.
  const [boardRow] = await privilegedSql<{ payload: ReplayBoard }[]>`
    select payload from demo_replay
     where user_id = ${snapshot} and kind = 'board' and key = ${BOARD_KEY}
  `;
  const board = boardRow?.payload.chunks ?? [];
  const picks = await selectBankable(snapCfg.id, cfg.base_model, board);
  const bank = await seedPublishedBank(snapshot, snapCfg.llm_model, picks);

  console.log("published:");
  console.log(
    `  ${summary.configs} config, ${summary.documents} documents, ${summary.chunks} chunks, ` +
      `${bank.remaining} questions on the board, ${summary.results} scores measured, ` +
      `${summary.rankings} graded rankings, ${bank.removed} questions emptied out, ` +
      `${summary.cachedAnswers} cached answers, ` +
      `${bank.banked} banked questions, ` +
      `${summary.shadowEvents} shadow events (${summary.shadowQueued} unjudged, ` +
      `${summary.shadowVerdicts} verdicts banked, ${summary.shadowPoolable} poolable), ` +
      `${summary.replayRows} model rows (${summary.replayScored} scored), ` +
      `${summary.sweepRows === 0 ? "no cache-key sweep" : `a cache-key sweep (${summary.sweepModels} models)`}, ` +
      `${summary.matrixPairs === 0 ? "NO replay matrix" : `a replay matrix over ${summary.matrixPairs} pairs`}, ` +
      `${summary.boardChunks === 0 ? "NO board scope" : `a board scoped to ${summary.boardChunks} chunks`}, ` +
      `${summary.ledgerRows === 0 ? "NO savings ledger" : `${summary.ledgerRows} savings row`}\n`,
  );
  // The payoff readout's money is the whole point of §4's bottom line, and its
  // absence is silent by design: readCacheEconomics turns a zero-event ledger
  // into `savedPerHitUsd: null`, which renders as a hit rate with no dollars
  // rather than as an error. So the publish says it here or nobody finds out.
  if (summary.ledgerRows === 0) {
    console.log(
      "\u26a0 no semantic_cache savings row reached the snapshot, so the payoff readout will\n" +
        "  show a hit rate with no money. The master accrues that row by SERVING cache hits —\n" +
        "  ask a repeated question on the published config and re-publish.\n",
    );
  }
  // The board's own failure mode, and it is quieter than the matrix's below:
  // readBoard returns null for a build without one, every reader falls through to
  // the unscoped path, and the guest's Eval tab renders all 236 chunk cards
  // exactly as it does today. That is a demo with no scope wearing the face of a
  // working one, so the publish says it here.
  if (summary.boardChunks === 0) {
    console.log(
      "\u26a0 no board scope reached the snapshot, so a guest's Eval tab is scoped to the\n" +
        "  whole corpus. Either the master carries no board row, or none of its chunk ids\n" +
        "  survived the clone's remap — check step 5g.\n",
    );
  }
  // Louder than the count above, because a build with no matrix is the one
  // failure of this phase that looks like a working publish: every other number
  // on the line is unchanged, and §4 goes back to being a poster.
  if (summary.matrixPairs === 0) {
    console.log(
      "⚠ no similarity matrix reached the snapshot, so the semantic-cache page has nothing\n" +
        "  to replay. Re-run with --sweep, which is what captures it.\n",
    );
  }
  // The one thing a guest can ADD without a key: "Bulk actions → Add question →
  // Add cached" reads question_cache, which the publish now CONSTRUCTS out of the
  // build's own frozen questions (docs/demo-question-bank-plan.md) rather than
  // inheriting whatever the master happened to have generated for this corpus.
  //
  // The composition is the report, not the count — twelve is the uninteresting
  // half, exactly as it is for the tunable set two screens up. What a visitor
  // notices is which files the questions are about, and whether adding them gives
  // autotune anything to find.
  if (bank.banked === 0) {
    console.log(
      "\u26a0 no banked questions published \u2014 nothing on the board was eligible, so a guest's\n" +
        "  board stays EMPTY and \u201cAdd cached\u201d has nothing to put on it. The build's own\n" +
        "  questions were left in place so the demo still shows something; check that the\n" +
        "  board scope reached the snapshot and that its chunks carry scored questions.\n",
    );
  } else {
    const tierLabel = (t: number) => (t === 99 ? "missed" : `rank ${t}`);
    console.log(
      `  the board a guest builds: ${bank.banked} banked question(s) over ${bank.documents} document(s) ` +
        `(${bank.tiers.map((t) => `${t.n} ${tierLabel(t.tier)}`).join(", ")}; ` +
        `${bank.difficulties.join(" + ")}), and the\n  published build emptied of all ` +
        `${bank.removed} of its own \u2014 so a guest arrives at a board with nothing on it and\n` +
        `  \u201cAdd cached\u201d is what fills it, up to ${bank.banked}, which is what scoring, nDCG and ` +
        `autotune then run over.\n`,
    );
    if (bank.banked < BANKED_QUESTION_CAP) {
      console.log(
        `\u26a0 only ${bank.banked} of ${BANKED_QUESTION_CAP} banked \u2014 the board's ${board.length} chunk(s) did not ` +
          `supply two scored\n  questions each. The demo still works; the board a guest can ` +
          `build is just smaller.\n`,
      );
    }
    // The old failure mode, kept as a check rather than as a warning nothing
    // could act on: selectBankable round-robins by document, so one document now
    // means the eligible set was confined to one, not that the bank drifted.
    if (bank.documents < 2) {
      console.log(
        `\u26a0 all ${bank.banked} banked questions come from ${bank.documents} document(s) \u2014 ` +
          `\u201cAdd cached\u201d would hand\n  a guest a board about one file. ` +
          `Check what else in this build is eligible.\n`,
      );
    }
    // The half that is invisible afterwards, and it inverted with §3.2: the risk
    // used to be a banked question LEFT in the build (fillChunksFromCache would
    // count it and then decline to add it, because selectNewQuestions dedupes on
    // wording). Now the delete is total, so ANY survivor is that same bug — a
    // question sitting on a board the demo promises is empty.
    if (bank.remaining !== 0) {
      console.log(
        `\u26a0 ${bank.remaining} question(s) survived the empty-out. A guest's board is meant to ` +
          `start blank;\n  these will be on it, unadded and \u2014 if their wording is banked \u2014 ` +
          `silently unaddable.\n`,
      );
    }
  }
  // The calibration curve (phase 6.2). Two failure modes, both silent from the
  // outside, and the second is the one that bites: a build can carry plenty of
  // shadow rows and still show a FLAT chart, because this account's real traffic
  // has never produced a reject (F7 — a census, not a shortage). What gives the
  // curve a shape is the probe sample, and what makes the panel a workbench
  // rather than a poster is the unjudged queue.
  if (summary.shadowEvents === 0) {
    console.log(
      "⚠ no shadow events published — Appraise → Semantic caching will show an empty\n" +
        "  calibration curve, which is the state phase 6.2 existed to fix. Check the\n" +
        "  master's semantic_cache_shadow has judged rows at or above the shadow floor.\n",
    );
  } else if (summary.shadowQueued === 0) {
    console.log(
      "⚠ every published shadow event is already judged — the Accept / Reject queue\n" +
        "  will be empty, so the one calibration control a guest is allowed to touch\n" +
        "  does nothing. It needs unjudged probe rows above the shadow floor.\n",
    );
  } else if (summary.shadowPoolable === 0) {
    // THE QUIET ONE, and the reason phase 4 counts this at all. A queue can be
    // full, its verdicts banked, the button instant — and judging every row move
    // nothing, because `poolPairs` drops a probe row that replayed a generated
    // pair (F3) and those rows have no cosine in the matrix. That is a demo whose
    // central claim is false and whose every visible number still looks right.
    console.log(
      "⚠ none of the queued rows are in the pooled set — judging them will not move\n" +
        "  the leaderboard. The queue preferred poolable rows and found none, so the\n" +
        "  master's probe rows are all F3 self-collisions. Re-run the probe replay.\n",
    );
  } else if (summary.shadowVerdicts < summary.shadowQueued) {
    console.log(
      `⚠ ${summary.shadowQueued - summary.shadowVerdicts} queued row(s) have no banked ` +
        "verdict — \"Run judge over queue\" will skip them\n  rather than judge them. " +
        "They are rows the copy's dedupe collapsed.\n",
    );
  }

  // The model comparison (phase 6.3). Same two directions as the shadow log, and
  // for the same reason: the count that reads as success is the SCORED one. A
  // build can carry all seventeen rows and still render a full table of dashes,
  // which is what the master held before this phase — and dashes in a table that
  // otherwise looks like a real appraisal is worse than an empty panel saying so.
  if (summary.replayRows === 0) {
    console.log(
      "⚠ no model comparison published — Appraise → Models will show its empty state\n" +
        "  (lib/demo/policy's `appraise` sentence). Re-publish without --skip-replay to\n" +
        "  warm it, or check the master's replay_metrics.\n",
    );
  } else if (summary.replayScored < 2) {
    console.log(
      `⚠ ${summary.replayRows} model rows published but only ${summary.replayScored} scored — the\n` +
        "  table will render as dashes. A model is scored only at 100% chunk coverage in\n" +
        "  the master's embedding_cache, so this means the cache no longer covers this\n" +
        "  corpus. Re-publish without --skip-replay.\n",
    );
  }

  // The cache-key sweep (phase 1 of docs/demo-cache-lab-plan.md). Same shape as
  // the two above: the count that reads as success is the one with CURVES, since
  // a curve is what the precision slider re-derives from and the slider is the
  // whole point of publishing this. A row of models with no curves is §4 wearing
  // the layout of a measurement and holding none.
  if (summary.sweepRows === 0) {
    console.log(
      "⚠ no cache-key sweep published — Appraise → Semantic caching's §4 will show its\n" +
        "  three disabled buttons and no table, which is the state this phase exists to fix.\n" +
        "  Re-publish without --skip-sweep, or check the master's published_sweep row.\n",
    );
  } else if (summary.sweepModels < 2) {
    console.log(
      `⚠ a cache-key sweep was published but only ${summary.sweepModels} model(s) carry a curve — the\n` +
        "  leaderboard renders as dashes and the precision slider has nothing to re-derive.\n" +
        "  Check the master's pair set is populated, then re-publish with --sweep.\n",
    );
  }

  // The frozen set is the complement, so this is an equation and not a guess: a
  // published question is either tunable or frozen. A mismatch means step 4d's
  // exclusion missed — and the failure it is guarding against is the silent
  // direction, where nothing froze and every guest gets a re-score button
  // pointed at all 472 questions.
  if (summary.frozen !== summary.questions - summary.rankings) {
    console.log(
      `⚠ ${summary.questions} questions published, ${summary.rankings} tunable, but ` +
        `${summary.frozen} frozen — expected ${summary.questions - summary.rankings}.\n` +
        `  A guest's re-score and autotune are scoped by the frozen rows, so this is\n` +
        `  the demo's spend limit disagreeing with itself. Do not leave it.\n`,
    );
  }
  // A silent shortfall here means the clone dropped a selected question — its
  // label did not resolve under the published config, say — and the demo ships
  // with a smaller tunable set than the spread assertion just approved.
  if (summary.rankings !== tunable.length) {
    console.log(
      `⚠ selected ${tunable.length} questions to grade but published ${summary.rankings} ` +
        `rankings.\n  The clone dropped some — check that every one of them is labeled ` +
        `under this config.\n`,
    );
  }

  await armAutotune(snapshot);

  const ok = await verifyFingerprints(snapshot);
  console.log();

  const seed = process.env.DEMO_SEED_USER_ID?.trim();
  if (seed !== snapshot) {
    console.log(
      `⚠ DEMO_SEED_USER_ID is ${seed ?? "unset"}, not the snapshot. Guests are still cloned\n` +
        `  from ${seed === master ? "the master account" : "somewhere else"} until you point it at\n` +
        `  ${snapshot} in .env.local and on Vercel (Production + Preview).\n`,
    );
  }

  console.log(`Published at ${new Date().toISOString()}.\n`);
  if (!ok) process.exit(1);
}

main()
  .then(() => privilegedSql.end())
  .catch(async (err) => {
    console.error(`\n✗ ${String(err)}\n`);
    await privilegedSql.end().catch(() => {});
    process.exit(1);
  });
