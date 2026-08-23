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
// nDCG stays null (renders "—"): it is graded against eval_rankings truth rows,
// which are Phase 3 and are not cloned yet. A null is honest; a recall-shaped
// number in the nDCG slot would not be.
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

  await privilegedSql.begin(async (tx) => {
    await tx`delete from eval_runs where config_id = ${cfg.id}`;
    await tx`
      insert into eval_runs
        (config_id, model, chunk_size, chunk_overlap, k, question_count, hit_count, mrr, ndcg, notes)
      values
        (${cfg.id}, ${cfg.base_model}, ${cfg.chunk_size}, ${cfg.chunk_overlap}, ${agg.k},
         ${agg.questions}, ${agg.hits}, ${agg.mrr}, null, 'as published')
    `;
  });

  const recall = ((100 * agg.hits) / agg.questions).toFixed(1);
  console.log(
    `frozen baseline: ${agg.hits}/${agg.questions} at k=${agg.k} — recall ${recall}%, ` +
      `MRR ${agg.mrr?.toFixed(3) ?? "—"}\n` +
      `  (replaced ${copied} run snapshot${copied === 1 ? "" : "s"} copied from the master)\n`,
  );
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

  console.log(`\nmaster    ${master}`);
  console.log(`snapshot  ${snapshot}  (${profile.email})\n`);
  console.log(`publishing "${cfg.name}" (${cfg.base_model})`);
  console.log(
    `  ${from.documents} documents, ${from.chunks} chunks, ` +
      `${from.labeled} questions${
        from.labeled === from.questions ? "" : ` (of ${from.questions} — the rest carry no label here)`
      }, ${from.scores} published scores, ${from.cached} cached answers`,
  );
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
  });

  console.log("published:");
  console.log(
    `  ${summary.configs} config, ${summary.documents} documents, ${summary.chunks} chunks, ` +
      `${summary.questions} questions, ${summary.results} scores, ` +
      `${summary.cachedAnswers} cached answers\n`,
  );

  await freezePublishedRun(snapshot, summary.runs);

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
