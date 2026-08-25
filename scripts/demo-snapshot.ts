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
//
// Env: DEMO_MASTER_USER_ID (the account you work in), DEMO_SNAPSHOT_USER_ID (the
// published one), DEMO_SNAPSHOT_EMAIL (only for --create; must be a real address,
// since password reset is the only way back into that account).
import { privilegedSql } from "../lib/db";
import { createSnapshotAccount } from "../lib/demo/admin";
import { cloneSeedWorkspace } from "../lib/demo/clone";
import { BANKED_QUESTION_CAP } from "../lib/demo/frozen";
import { ndcg } from "../lib/rag/evalMetrics";
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

// --- THE TWELVE ---------------------------------------------------------------
//
// Which questions get a graded-nDCG drilldown in the published demo, and — once
// phase 4 lands — which ones a visitor may re-score and autotune.
//
// SELECTED BY QUERY, NOT BY HAND, so a re-publish after the master has moved
// re-rolls the set against the corpus as it now scores rather than pinning twelve
// uuids that quietly stopped being interesting. The trade is that a re-publish can
// silently produce a duller set, which is what assertSpread below is for.
//
// THE COMPOSITION IS THE WHOLE POINT. Autotune only has work to do on questions
// that are FAILING: twelve rank-1 hits give the demo's most interesting button
// nothing to search for. So the quota is weighted at the hard tail of the
// distribution the demo actually publishes (measured 2026-08-22, the no-override
// generation): 355 at rank 1, 62 at 2, 16 at 3, 11 at 4, none at 5, 28 missed.
//
// A couple of comfortable questions are in the set deliberately — a drilldown
// showing what a rank-1 ideal ordering looks like is what makes the failures
// legible as failures.
const QUOTAS: { tier: number; n: number; label: string }[] = [
  { tier: 99, n: 4, label: "missed" }, // 99 = not found in the top k
  { tier: 4, n: 3, label: "rank 4" },
  { tier: 3, n: 3, label: "rank 3" },
  { tier: 2, n: 1, label: "rank 2" },
  { tier: 1, n: 1, label: "rank 1" },
];

type Tunable = { id: string; tier: number; chunk: string; document: string };

// ONE QUESTION PER SOURCE CHUNK. Autotune reshapes CHUNKS, so twelve questions
// hanging off one chunk is one candidate search wearing twelve hats — the plan's
// "several distinct chunks" requirement, enforced rather than hoped for.
//
// Ordered by md5(id) inside every bucket, not by id or created_at: those correlate
// with ingest order, which correlates with document, and the top of the list would
// be four questions from whichever file was uploaded first. md5 is stable, so the
// same corpus re-rolls the same twelve.
async function selectTunable(configId: string): Promise<Tunable[]> {
  // The quota table, inlined as a CASE rather than joined in as a VALUES list, so
  // QUOTAS above stays the single place the composition is written down.
  const quotaCase =
    QUOTAS.map((q) => `when ${q.tier} then ${q.n}`).join(" ") + " else 0";
  return privilegedSql.unsafe<Tunable[]>(
    `with latest as (
       select distinct on (r.eval_label_id, r.k)
              r.eval_question_id as id,
              coalesce(r.found_rank, 99) as tier,
              l.source_chunk_id::text as chunk,
              q.document_id::text as document
         from eval_results r
         join eval_labels l on l.id = r.eval_label_id
         join document_embeddings de on de.id = l.document_embedding_id
         join eval_questions q on q.id = r.eval_question_id
        where de.config_id = $1
          and r.retrieval_state = 'baseline' and not r.is_baseline
          -- Ungradable without one: this selection decides which truth rows get
          -- cloned, and a question with none cannot supply one.
          and exists (select 1 from eval_rankings er
                       join document_embeddings de2 on de2.id = er.document_embedding_id
                      where er.eval_question_id = q.id and er.is_truth
                        and de2.config_id = $1)
          -- Ignored on the master (0014), holdout rows (0061) included: the
          -- operator took these out of the live aggregate, so they are not the
          -- questions to hand a visitor.
          and not exists (select 1 from config_question_ignores i
                           where i.config_id = $1 and i.eval_question_id = q.id)
        order by r.eval_label_id, r.k, r.scored_at desc
     ),
     per_chunk as (
       select distinct on (chunk) * from latest order by chunk, md5(id::text)
     ),
     ranked as (
       select *, row_number() over (partition by tier order by md5(id::text)) as rn
         from per_chunk
     )
     select id::text as id, tier::int as tier, chunk, document
       from ranked
      where rn <= case tier ${quotaCase} end
      order by tier desc, md5(id::text)`,
    [configId] as never[],
  );
}

// REFUSE A DULL BUILD. The set drifts on purpose, so the failure mode is not a
// crash — it is a publish that quietly hands every visitor twelve rank-1 questions,
// an autotune button with nothing to search, and a drilldown that shows twelve
// identical perfect orderings. That is a worse demo than the one this replaces, and
// it would ship without a single error.
//
// The bars are deliberately below the quota: the quota is what we ask for, this is
// what the demo cannot do without.
function assertSpread(picked: Tunable[]): void {
  const misses = picked.filter((p) => p.tier === 99).length;
  const tail = picked.filter((p) => p.tier >= 3).length; // rank 3+ or missed
  const easy = picked.filter((p) => p.tier === 1).length;
  const chunks = new Set(picked.map((p) => p.chunk)).size;
  const docs = new Set(picked.map((p) => p.document)).size;

  const problems: string[] = [];
  if (picked.length < 8) problems.push(`only ${picked.length} tunable questions (want 12)`);
  if (misses < 2) problems.push(`only ${misses} missed question(s) — autotune needs failures`);
  if (tail < 5) problems.push(`only ${tail} in the hard tail (rank 3+ or missed)`);
  if (easy < 1) problems.push("no rank-1 question — nothing to show a working retrieval against");
  if (chunks < 8) problems.push(`only ${chunks} distinct chunks — autotune reshapes chunks`);
  if (docs < 2) problems.push(`only ${docs} document(s)`);
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

  const [cfg] = await privilegedSql<{ name: string; base_model: string }[]>`
    select name, base_model from configs where id = ${configId} and user_id = ${master}
  `;
  if (!cfg) die(`config ${configId} is not owned by the master account.`);

  const from = await sourceCensus(configId, cfg.base_model);
  const to = await destCensus(snapshot);
  const tunable = await selectTunable(configId);

  console.log(`\nmaster    ${master}`);
  console.log(`snapshot  ${snapshot}  (${profile.email})\n`);
  console.log(`publishing "${cfg.name}" (${cfg.base_model})`);
  console.log(
    `  ${from.documents} documents, ${from.chunks} chunks, ` +
      `${from.labeled} questions${
        from.labeled === from.questions ? "" : ` (of ${from.questions} — the rest carry no label here)`
      }, ${from.scores} published scores, ${from.cached} cached answers`,
  );
  // The composition, not just the count: twelve is the uninteresting half of this
  // number and the spread is the half that decides whether the demo has a working
  // autotune button.
  const tiers = QUOTAS.map((q) => {
    const n = tunable.filter((t) => t.tier === q.tier).length;
    return n > 0 ? `${n} ${q.label}` : null;
  }).filter(Boolean);
  console.log(
    `  ${tunable.length} of them graded for nDCG (${tiers.join(", ")}), over ` +
      `${new Set(tunable.map((t) => t.chunk)).size} chunks in ` +
      `${new Set(tunable.map((t) => t.document)).size} documents`,
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

  const summary = await cloneSeedWorkspace(master, snapshot, {
    onlyConfigId: configId,
    replaceDestination: true,
    tunableQuestionIds: tunable.map((t) => t.id),
  });

  console.log("published:");
  console.log(
    `  ${summary.configs} config, ${summary.documents} documents, ${summary.chunks} chunks, ` +
      `${summary.questions} questions, ${summary.results} scores, ` +
      `${summary.rankings} graded rankings, ${summary.frozen} frozen, ` +
      `${summary.cachedAnswers} cached answers, ` +
      `${summary.bankedQuestions} banked questions, ` +
      `${summary.shadowEvents} shadow events (${summary.shadowQueued} unjudged)\n`,
  );
  // The one thing a guest can ADD without a key: "Bulk actions → Add question →
  // Add cached" reads question_cache, which step 4e of the clone now carries
  // (phase 6.1 of docs/demo-analytics-plan.md).
  //
  // Both directions are worth a line, because the count alone reads the same
  // either way. A CAPPED build is working as designed and the number is not the
  // master's — say which. An EMPTY one is not an error (the master's bank only
  // fills as it generates) but it is a dead button on the published build, and it
  // is invisible from the outside.
  if (summary.bankedQuestions === 0) {
    console.log(
      "⚠ no banked questions published — the master's question_cache holds nothing for\n" +
        "  this corpus's chunk text, so a guest's \u201cAdd cached\u201d will find nothing to add.\n" +
        "  Generate some questions on the master and re-publish to give it something.\n",
    );
  } else if (summary.bankedAvailable > summary.bankedQuestions) {
    console.log(
      `  (${summary.bankedAvailable} passages had banked wording; capped to ` +
        `${BANKED_QUESTION_CAP} — a guest's tunable set tops out at ` +
        `${tunable.length + summary.bankedQuestions}, which is what autotune runs over.)\n`,
    );
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

  await freezePublishedRun(snapshot, summary.runs);
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
