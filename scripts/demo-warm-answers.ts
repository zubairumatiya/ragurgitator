// WARM THE DEMO'S TUNABLE ANSWERS — buy, on the master, the banked answers the
// published demo cannot generate for itself.
//
//   npm run demo:warm              dry run: which questions are dead, and what
//                                  answering them would cost
//   npm run demo:warm -- --yes     answer them, through the real chat path
//
// WHY THIS EXISTS. A guest holds a Voyage key and nothing else, so the only
// questions the demo can answer are the ones with a banked answer in
// semantic_cache. The twelve tunable questions are the ones the demo points at —
// the suggestion chips, the nDCG drilldown, the autotune button — and seven of
// them had no banked answer at all: /api/chat reached generation, found no
// answer-model key, and returned DEMO_BLOCKED. The publish counted 252 cached
// answers and said nothing about which twelve mattered (fixed in the same change:
// demo-snapshot now runs the same census before it publishes).
//
// IT GOES THROUGH ask(), NOT AN INSERT. semanticCacheStore writes query_hash,
// query_vector, dimension, fingerprint and llm_model from the scope it runs in,
// and a hand-written row that gets any one of those wrong is invisible until a
// visitor's lookup misses — worse than no row, because it also looks fixed. So
// this enters the master's user + config scope and calls the same pipeline
// /api/chat calls; the cache write is a side effect of the answer, exactly as in
// production.
//
// SPEND. Every question is priced before anything is called and the run refuses
// to start above CEILING_USD. Actual dollars are read back from
// provider_key_usage (0072) rather than re-estimated, so the number printed at
// the end is the ledger's, not this script's.
import postgres from "postgres";

import { activeUserId, withUser } from "../lib/auth/userScope";
import { config, cheapModelFor } from "../lib/config";
import { sql as scopedSql } from "../lib/db";
import { sslFor } from "../lib/dbSsl";
import { selectTunable, tunableAnswerCensus, tunableCacheKey } from "../lib/demo/tunable";
import { activeConfig, resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { ask } from "../lib/rag/pipeline";
import { costLlm, estimateTokensAll } from "../lib/rag/pricing";
import { retrieveForQuery } from "../lib/rag/retriever";
import { semanticCacheLookup } from "../lib/rag/semanticCache";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);

// A hard stop rather than a warning. The projection below is an estimate over
// estimated token counts; the ceiling is the thing that stays true when the
// estimate is wrong, and a demo warm-up that can only ever be a few cents has no
// business being able to run away.
const CEILING_USD = 0.5;

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main(): Promise<void> {
  const master = process.env.DEMO_MASTER_USER_ID?.trim();
  if (!master) die("DEMO_MASTER_USER_ID is not set.");

  // The same default the publish uses — the master's leftmost open tab — so the
  // two scripts warm and publish the same build without being told twice.
  const configId =
    process.env.SCRIPT_CONFIG_ID ??
    (
      await sql<{ id: string }[]>`
        select id from configs where user_id = ${master} and is_open
         order by tab_order, created_at limit 1
      `
    )[0]?.id;
  if (!configId) die("the master account has no open config (set SCRIPT_CONFIG_ID).");

  const [owner] = await sql<{ user_id: string; email: string }[]>`
    select c.user_id, u.email from configs c join auth.users u on u.id = c.user_id
     where c.id = ${configId}
  `;
  if (!owner) die(`config ${configId} not found`);
  if (owner.user_id !== master) die(`config ${configId} is not owned by the master account.`);

  const key = await tunableCacheKey(configId);
  if (!key) die(`config ${configId} has no chunk table — nothing to answer from.`);

  const tunable = await selectTunable(configId);
  const census = await tunableAnswerCensus(configId, tunable);
  const missing = census.filter((c) => !c.cached);

  console.log(`\nmaster config  ${configId}  (${owner.email})`);
  console.log(`cache key      ${key.keyModel} / ${key.llmModel} / ${key.fingerprint}`);
  console.log(
    `\n${census.length} tunable questions, ${census.length - missing.length} banked, ${missing.length} with no answer\n`,
  );
  if (missing.length === 0) {
    console.log("Nothing to warm.\n");
    return;
  }

  // ONE SCOPE PER UNIT OF WORK, not one around the whole run. A scope is a
  // transaction (0051), and wrapping seven generations in a single one would hold
  // it open across minutes of provider latency on the live database — which is
  // also not the shape production has: a request is one answer, one transaction.
  const inScope = <T,>(fn: () => Promise<T>): Promise<T> =>
    withUser({ id: owner.user_id, email: owner.email }, async () => {
      const scoped = await resolveConfig(configId);
      if (!scoped) die("config not found in the master's scope");
      return withConfig(scoped, fn);
    });

  await run(missing.map((m) => m.question), inScope);
}

type InScope = <T>(fn: () => Promise<T>) => Promise<T>;
type Purchase = { question: string; inputTokens: number };

async function run(questions: string[], inScope: InScope): Promise<void> {
  const { strong, cheap } = await inScope(async () => {
    const cfg = activeConfig();
    return {
      strong: cfg.llmModel,
      cheap: cfg.cascadeEnabled ? cheapModelFor(cfg.llmModel) : cfg.llmModel,
    };
  });

  // --- price it, one question at a time ------------------------------------
  //
  // Priced from the chunks retrieval ACTUALLY returns rather than from top_k ×
  // chunk_size, which costs one (cached) embed per question and makes the number
  // the ceiling is checked against the real prompt rather than a bound on it.
  const buy: Purchase[] = [];
  for (const question of questions) {
    const priced = await inScope(() => price(question));
    if (priced === null) {
      console.log(`  ✔ already served by a neighbour, no spend: "${question}"`);
      continue;
    }
    buy.push(priced);
  }

  if (buy.length === 0) {
    console.log("\nEvery uncached question is already reachable through a neighbour.\n");
    return;
  }

  // WORST CASE, deliberately. Every question is priced as if the cascade escalates
  // (cheap answer discarded, strong answer paid for) and as if both legs fill
  // maxAnswerTokens, because the number the ceiling is checked against has to be
  // the one this run cannot exceed, not the one it probably costs.
  const out = config.maxAnswerTokens;
  const projected = buy.reduce(
    (sum, b) =>
      sum + costLlm(cheap, b.inputTokens, out) + (cheap === strong ? 0 : costLlm(strong, b.inputTokens, out)),
    0,
  );
  console.log(`\n${buy.length} questions to answer (${cheap}${cheap === strong ? "" : ` → ${strong}`}):\n`);
  for (const b of buy) console.log(`    ${b.inputTokens.toString().padStart(6)} tok  ${b.question}`);
  console.log(`\nprojected worst case: ${usd(projected)}  (ceiling ${usd(CEILING_USD)})\n`);
  if (projected > CEILING_USD) {
    die(`projection exceeds the ceiling — refusing to start.`);
  }
  if (!has("--yes")) {
    console.log("Dry run. Re-run with --yes to answer them.\n");
    return;
  }

  // --- spend ----------------------------------------------------------------
  //
  // Cost is read from the key ledger between calls rather than accumulated from
  // the token counts ask() does not return: it is the same number /usage shows,
  // it counts the efficacy gate's embed and any escalation without being told
  // about them, and it cannot drift from what was actually billed.
  let spent = 0;
  for (const [i, b] of buy.entries()) {
    console.log(`\n[${i + 1}/${buy.length}] ${b.question}`);
    const { model, escalated, sources, cost } = await inScope(() => answerOne(b.question));
    spent += cost;
    console.log(
      `  answered by ${model}${escalated ? " (escalated)" : ""}, ` +
        `${sources} sources, ${usd(cost)} — running total ${usd(spent)}`,
    );
    if (spent > CEILING_USD) {
      die(`spend crossed the ceiling after ${i + 1} question(s) — stopping.`);
    }
  }

  // --- verify, by looking up rather than by selecting ------------------------
  //
  // A select on the row just written proves the insert ran; it does not prove the
  // row is REACHABLE, which is the only property that matters and the one a
  // mis-derived key silently breaks. So every question goes back through
  // semanticCacheLookup — the same call /api/chat makes — and has to come back a
  // hit.
  console.log(`\nverifying by lookup:\n`);
  let bad = 0;
  for (const b of buy) {
    const { hit } = await inScope(() => lookup(b.question));
    if (!hit) bad++;
    console.log(`  ${hit ? "✔" : "✗"} ${b.question}`);
  }
  console.log(
    `\n${buy.length - bad}/${buy.length} reachable, ${usd(spent)} spent.` +
      (bad === 0 ? "\n" : "\n\n⚠ a miss here means the key derivation is wrong and the spend bought nothing.\n"),
  );
}

// The lookup /api/chat makes, with the shadow row suppressed: a cosine cannot
// exceed 1, so `floor: 1.1` records nothing. This script is an operator warming a
// build, not traffic, and the calibration curve is a census of real questions (F7).
async function lookup(question: string) {
  return semanticCacheLookup(question, {
    serve: true,
    threshold: null,
    keyModel: null,
    shadow: { floor: 1.1 },
  });
}

// null when the question needs no spend: a neighbour above τ already answers it,
// so a guest asking it is served rather than blocked, exact row or not.
async function price(question: string): Promise<Purchase | null> {
  const probe = await lookup(question);
  if (probe.hit) return null;
  const sources = probe.queryVector ? await retrieveForQuery(question, probe.queryVector) : [];
  return {
    question,
    inputTokens: estimateTokensAll([question, ...sources.map((s) => s.chunk.chunk.text)]),
  };
}

async function answerOne(question: string) {
  const before = await ledgerTotal();
  const result = await ask(question);
  return {
    model: result.model,
    escalated: result.escalated,
    sources: result.sources.length,
    cost: (await ledgerTotal()) - before,
  };
}

// READ THROUGH THE SCOPED HANDLE, not the bare client at the top of this file.
// withUser opens a TRANSACTION (0051) and the meter's insert lands inside it, so
// a second connection would see nothing until the whole run committed and every
// per-question delta would read zero.
async function ledgerTotal(): Promise<number> {
  const [row] = await scopedSql<{ total: string }[]>`
    select coalesce(sum(cost_usd), 0)::text as total
      from provider_key_usage where user_id = ${activeUserId()}
  `;
  return Number(row.total);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
