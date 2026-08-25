// PROBE REPLAY, Phase 1 measurement — how many pairs can actually produce a probe?
//
//   npm run probe:eligibility
//
// WHY THIS IS A SCRIPT AND NOT AN ASSUMPTION. The plan's headline number (186 of 222
// pairs whose origin question is banked) was counted on TEXT ALONE, and the lookup
// does not work on text alone: semanticCacheLookup scans
// (user_id, embedding_model, llm_model, fingerprint), so a banked question under a
// different answering model or a rotated fingerprint is unreachable. 186 is an upper
// bound and this prints the real number underneath it — which is what the Phase 3 cap
// has to be picked from.
//
// READ-ONLY. It runs eligiblePairs() and counts; it never replays, so it writes no
// shadow rows and spends nothing.
import postgres from "postgres";

import { withUser } from "../lib/auth/userScope";
import { sslFor } from "../lib/dbSsl";
import { resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { eligiblePairs } from "../lib/rag/probeReplay";
import { currentFingerprint, resolveKeyModel } from "../lib/rag/semanticCache";

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const USER = { id: "", email: "" };

async function loadOwner(): Promise<void> {
  const [row] = await sql<{ user_id: string; email: string }[]>`
    select c.user_id, u.email from configs c join auth.users u on u.id = c.user_id
    where c.id = ${CONFIG_ID}`;
  if (!row) throw new Error(`config ${CONFIG_ID} not found`);
  USER.id = row.user_id;
  USER.email = row.email;
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return withUser(USER, async () => {
    const cfg = await resolveConfig(CONFIG_ID);
    if (!cfg) throw new Error("config not found in user scope");
    return withConfig(cfg, fn);
  });
}

async function main(): Promise<void> {
  await loadOwner();

  await inScope(async () => {
    const { activeConfig } = await import("../lib/rag/activeConfig");
    const cfg = activeConfig();
    const keyModel = resolveKeyModel(null);
    const fingerprint = await currentFingerprint(cfg);

    // The funnel, each step narrowing by exactly one of the lookup's WHERE columns,
    // so a disappointing final number says WHICH constraint ate it. Counted here in
    // raw SQL rather than through eligiblePairs precisely because the intermediate
    // steps are the diagnosis.
    const [totals] = await sql<
      {
        pairs: string;
        banked_any: string;
        banked_scoped: string;
        cache_rows: string;
        fingerprints: string;
      }[]
    >`
      select
        (select count(*) from semantic_cache_pairs p
           join eval_questions q on q.id = p.origin_question_id
           join documents d on d.id = q.document_id
          where d.user_id = ${USER.id}) as pairs,
        -- text alone: the plan's upper bound, ignoring every scoping column
        (select count(*) from semantic_cache_pairs p
           join eval_questions q on q.id = p.origin_question_id
           join documents d on d.id = q.document_id
          where d.user_id = ${USER.id}
            and exists (select 1 from semantic_cache sc
                         where sc.user_id = ${USER.id}
                           and sc.query_hash = encode(sha256(q.question::bytea), 'hex'))
        ) as banked_any,
        -- what the lookup can actually reach
        (select count(*) from semantic_cache_pairs p
           join eval_questions q on q.id = p.origin_question_id
           join documents d on d.id = q.document_id
          where d.user_id = ${USER.id}
            and exists (select 1 from semantic_cache sc
                         where sc.user_id = ${USER.id}
                           and sc.embedding_model = ${keyModel}
                           and sc.llm_model = ${cfg.llmModel}
                           and sc.fingerprint = ${fingerprint}
                           and sc.query_hash = encode(sha256(q.question::bytea), 'hex'))
        ) as banked_scoped,
        (select count(*) from semantic_cache where user_id = ${USER.id}) as cache_rows,
        (select count(distinct fingerprint) from semantic_cache where user_id = ${USER.id})
          as fingerprints
    `;

    const eligible = await eligiblePairs(10_000);
    const hard = eligible.filter((p) => p.difficulty === "hard-negative").length;
    const questions = new Set(eligible.map((p) => p.originQuestionId)).size;

    console.log(`config      ${cfg.id} (${cfg.llmModel})`);
    console.log(`key model   ${keyModel}`);
    console.log(`fingerprint ${fingerprint}`);
    console.log(`cache       ${totals.cache_rows} rows, ${totals.fingerprints} fingerprints\n`);

    console.log(`pairs                              ${totals.pairs}`);
    console.log(`  origin banked (text only)        ${totals.banked_any}   ← the plan's upper bound`);
    console.log(`  origin banked (full lookup key)  ${totals.banked_scoped}`);
    console.log(`  minus already-probed variants    ${eligible.length}   ← ELIGIBLE NOW`);
    console.log(
      `\n${hard} hard negatives / ${eligible.length - hard} paraphrases, over ${questions} distinct origin questions`,
    );
  });

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
