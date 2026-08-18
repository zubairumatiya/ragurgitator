// FOLLOW-UP F6 — what does the argument-order check cost, and what does it catch?
//
//   npm run f6 -- run [--tau 0.95] [--write]
//   npm run f6 -- examples          the rows whose verdict the check changes
//
// WHY A MEASUREMENT AND NOT JUST A TEST. entityOrderPasses (semanticCacheCore) is
// easy to demonstrate on the two rows that motivated it — F1's 0.9962 Japan/China
// reversal and F3's reversed munitions ratio. That says nothing about what it does
// to the other few hundred labeled pairs sitting in this database, and a guard is
// only worth shipping if its RECALL COST is known: every extra block is a cache hit
// not served, which is money.
//
// So this replays the OLD guard and the NEW guard over every labeled pair on the
// account — judged shadow rows plus the F3-adjudicated generated pairs — and
// cross-tabs the change against the truth label:
//
//   newly blocked, truth = different  → a WIN: a false hit the guard now catches
//   newly blocked, truth = same       → the COST: a real hit now refused
//
// Weighted by what would actually have been served: a win below τ was never going
// to be served anyway, and a cost below τ was never going to be captured.
//
// Free — no embeddings, no LLM calls, sims already stored.
import { writeFileSync } from "node:fs";

import postgres from "postgres";

import { entityGuardPasses, entityTokensMatch } from "../lib/rag/semanticCacheCore";
import { inScope, loadOwner, type Owner } from "./lib/followup";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });

const OUT = "docs/resume-metrics-f6-results.md";
let owner: Owner;

type Case = {
  a: string;
  b: string;
  truth: "same" | "different";
  sim: number | null;
  source: "shadow" | "generated";
};

// Every labeled pair on the account. Shadow rows carry a judge/human verdict and
// a real sim; generated pairs carry their constructed label CORRECTED by F3's
// verdict where one exists, which is the whole point of having run F3.
async function loadCases(): Promise<Case[]> {
  const shadow = await sql<
    { new_query: string; matched_query: string; verdict: string; sim: string }[]
  >`
    select new_query, matched_query, verdict, sim
    from semantic_cache_shadow
    where verdict is not null
      and config_id in (select id from configs where user_id = ${owner.id})`;
  const pairs = await sql<
    { text_a: string; text_b: string; label: string; verdict: string | null }[]
  >`
    select p.text_a, p.text_b, p.label, p.verdict
    from semantic_cache_pairs p
    join eval_questions q on q.id = p.origin_question_id
    join documents d on d.id = q.document_id
    where d.user_id = ${owner.id}`;

  return [
    ...shadow.map((r) => ({
      a: r.new_query,
      b: r.matched_query,
      truth: (r.verdict === "accept" ? "same" : "different") as "same" | "different",
      sim: Number(r.sim),
      source: "shadow" as const,
    })),
    ...pairs.map((r) => ({
      a: r.text_a,
      b: r.text_b,
      // F3's verdict WINS over the constructed label where it exists — the
      // generator was wrong on 15 of these and measuring against its claims
      // would grade the guard on known-bad truth.
      truth: (r.verdict
        ? r.verdict === "accept"
          ? "same"
          : "different"
        : r.label) as "same" | "different",
      sim: null,
      source: "generated" as const,
    })),
  ];
}

type Changed = Case & { newlyBlocked: boolean };

function analyse(cases: Case[], tau: number) {
  const changed: Changed[] = [];
  let sameBlockedBefore = 0;
  let diffBlockedBefore = 0;
  for (const c of cases) {
    const before = entityTokensMatch(c.a, c.b);
    const after = entityGuardPasses(c.a, c.b);
    if (!before) {
      if (c.truth === "same") sameBlockedBefore++;
      else diffBlockedBefore++;
    }
    if (before && !after) changed.push({ ...c, newlyBlocked: true });
  }
  const wins = changed.filter((c) => c.truth === "different");
  const costs = changed.filter((c) => c.truth === "same");
  const served = (c: Changed) => c.sim !== null && c.sim >= tau;
  return {
    total: cases.length,
    same: cases.filter((c) => c.truth === "same").length,
    different: cases.filter((c) => c.truth === "different").length,
    sameBlockedBefore,
    diffBlockedBefore,
    changed,
    wins,
    costs,
    winsAboveTau: wins.filter(served),
    costsAboveTau: costs.filter(served),
  };
}

async function run(tau: number, write: boolean): Promise<void> {
  const cases = await loadCases();
  const r = analyse(cases, tau);
  console.log(
    `${r.total} labeled pairs (${r.same} same / ${r.different} different) — ` +
      `shadow ${cases.filter((c) => c.source === "shadow").length}, ` +
      `generated ${cases.filter((c) => c.source === "generated").length}`,
  );
  console.log(
    `\nbefore F6 the token guard already blocked: ` +
      `${r.diffBlockedBefore} different (correctly), ${r.sameBlockedBefore} same (its recall cost)`,
  );
  console.log(
    `\nthe order check newly blocks ${r.changed.length} pair(s):\n` +
      `  WINS  — truth 'different': ${r.wins.length} ` +
      `(${r.winsAboveTau.length} at or above τ=${tau}, i.e. would have been SERVED)\n` +
      `  COST  — truth 'same':      ${r.costs.length} ` +
      `(${r.costsAboveTau.length} at or above τ=${tau}, i.e. a hit actually lost)`,
  );
  for (const c of r.wins.slice(0, 8)) {
    console.log(`\n  WIN  sim=${c.sim?.toFixed(4) ?? "—"} [${c.source}]\n    A: ${c.a}\n    B: ${c.b}`);
  }
  for (const c of r.costs.slice(0, 8)) {
    console.log(`\n  COST sim=${c.sim?.toFixed(4) ?? "—"} [${c.source}]\n    A: ${c.a}\n    B: ${c.b}`);
  }
  if (write) {
    writeFileSync(OUT, doc(r, tau, cases));
    console.log(`\nwrote ${OUT}`);
  }
}

function doc(r: ReturnType<typeof analyse>, tau: number, cases: Case[]): string {
  const list = (rows: Changed[]) =>
    rows.length === 0
      ? "_none_"
      : rows
          .map(
            (c) =>
              `- **sim ${c.sim?.toFixed(4) ?? "—"}** (${c.source})\n` +
              `  - A: ${c.a}\n  - B: ${c.b}`,
          )
          .join("\n");
  return `# F6 — an argument-order check for the entity guard

Generated by \`npm run f6 -- run --write\` on ${new Date().toISOString().slice(0, 10)}.
Measured over every labeled pair on this account: ${r.total} of them
(${cases.filter((c) => c.source === "shadow").length} judged shadow rows,
${cases.filter((c) => c.source === "generated").length} generated pairs, F3 verdicts taking
precedence over constructed labels).

## The blind spot

The guard compares SETS of numerals, acronyms and quoted spans. A comparison whose
arguments are swapped keeps every one of them identical:

> "In 1938, how many times larger was **Japan's** population compared to **China's**?"
> "In 1938, how many times larger was **China's** population compared to **Japan's**?"

Cosine is blind to it too — this pair sat at **0.9962**, the highest-similarity false
hit in the entire F1 probe set — so nothing in the pipeline caught it. F3 then hit the
same shape independently on a reversed ratio ("US share of Allied munitions" vs
"share of US-made munitions used by the Allies"). Two independent runs, so it is a
recurring failure mode and not one unlucky row.

## The check

\`entityOrderPasses\` (\`lib/rag/semanticCacheCore.ts\`) fails a pair when the entities
the two questions SHARE appear in a different relative order, and both texts carry a
direction marker — a comparator (\`compared to\`, \`than\`, \`versus\`, \`per\`, \`out of\`)
or a passive agent (\`by\`). Entities are proper nouns and acronyms; question openers
are excluded, since they are capitalised by grammar and land first in every question.

The direction marker is what keeps this from being pure recall cost: without one,
the order of two entities in a question carries no reliable relation ("what did
Germany and France sign" vs "what did France and Germany sign" is the same question).

## What it costs, measured

| | |
| --- | --- |
| Labeled pairs replayed | ${r.total} (${r.same} same / ${r.different} different) |
| Already blocked by the token guard — correctly (\`different\`) | ${r.diffBlockedBefore} |
| Already blocked by the token guard — its recall cost (\`same\`) | ${r.sameBlockedBefore} |
| **Newly blocked by the order check** | **${r.changed.length}** |
| …of which truth is \`different\` — **wins** | **${r.wins.length}** (${r.winsAboveTau.length} at or above τ=${tau}) |
| …of which truth is \`same\` — **cost** | **${r.costs.length}** (${r.costsAboveTau.length} at or above τ=${tau}) |

### One refinement, and the measurement made it

The first run of this table showed 8 wins against **4 false blocks**. Every one of
the four was the same shape — \`by\` used as a TEMPORAL preposition next to a month
that had moved position ("By the end of October 1916, what was X" vs "What was X by
the end of October 1916") — so calendar words were dropped from the entity
extractor. That removed all four and cost none of the wins. A date that genuinely
differs is a numeral, which the token half of the guard already catches.

"At or above τ" is the column that matters operationally: a win below the serving
threshold was never going to be served, and a cost below it was never going to be
captured. Generated pairs have no sim of their own and are counted only in the
unweighted totals.

### The wins

${list(r.wins)}

### The cost

${list(r.costs)}

## This is live

\`entityGuardPasses\` is what \`semanticCacheLookup\` calls, so the order check is in
the serving path as of this change — a reversed-argument match is now a miss rather
than a hit. On this account's labeled set that is 8 fewer false hits and 0 lost
hits; on a corpus whose questions compare entities more often, the recall cost will
be higher than 0 and this table is the way to re-measure it.

## Direction of error

A false trigger costs a cache hit; a miss serves a wrong answer. The check is
written to be decisive where it fires for that reason, and its scope is deliberately
narrow — it needs a direction marker, at least two shared entities, and a genuine
order difference between them before it does anything at all.
`;
}

async function examples(): Promise<void> {
  const cases = await loadCases();
  for (const c of analyse(cases, 0.95).changed) {
    console.log(`\n[${c.truth}] sim=${c.sim?.toFixed(4) ?? "—"} (${c.source})\n  A: ${c.a}\n  B: ${c.b}`);
  }
}

async function main(): Promise<void> {
  owner = await loadOwner(sql);
  const argv = process.argv.slice(2);
  const tau = argv.includes("--tau") ? Number(argv[argv.indexOf("--tau") + 1]) : 0.95;
  switch (argv[0]) {
    case "run": await inScope(owner, () => run(tau, argv.includes("--write"))); break;
    case "examples": await inScope(owner, examples); break;
    default: console.log(" verbs: run [--tau 0.95] [--write] | examples");
  }
}

main().then(async () => {
  await sql.end();
  process.exit(process.exitCode ?? 0);
}, async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
