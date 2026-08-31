// FUSION EGRESS — the measuring instrument (docs/fusion-egress-plan.md §2).
//
//   npm run egress -- start "master re-score"   snapshot before a walk
//   npm run egress -- report                    snapshot after it, print the delta
//   npm run egress -- show                      cumulative totals, no delta
//   npm run egress -- walk [n]                  run THE fixed walk and grade it
//
// `pg_stat_statements` counts calls and ROWS, never bytes, so bytes here are
// rows x a measured average row width. The widths are queried from the live
// tables at `start` and carried in the state file, so `report` scores the walk
// with the same ruler the baseline used even if the corpus grows underneath it.
//
// No reset is needed and none is taken: pg_stat_statements is cumulative, so a
// difference between two snapshots is exact and does not disturb anyone else's
// reading (`stats_reset` is 2026-07-06 and should stay there).
//
// This runs against LIVE on purpose. The throwaway integration database has no
// corpus, no override pieces and no pg_stat_statements — there is nothing there
// to walk and nothing to count (§1.4).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { activeConfig } from "../lib/rag/activeConfig";
import { getActiveCriteria } from "../lib/rag/evalSettingsStore";
import { retrievalDepth } from "../lib/rag/evalSettingsStore";
import { getCachedQueryEmbeddings } from "../lib/rag/evalStore";
import { retrievalStateFingerprint } from "../lib/rag/overrideStore";
import { buildRetrievalContext, retrieveWithCutoffs } from "../lib/rag/retriever";
import { sql as scoped } from "../lib/db";
import { CONFIG_ID, inScope, loadOwner } from "./lib/followup";

// Outside the repo's tracked tree (data/ is gitignored) — a baseline is a local
// measurement, not a source file, and two people's baselines must not collide.
const STATE = process.env.EGRESS_STATE ?? "data/egress-meter.json";

// The demo master's chunk table. Widths are measured here because this is the
// config the loops run against and therefore the config whose rows the numbers
// below are made of.
const CHUNKS_TABLE = process.env.EGRESS_CHUNKS_TABLE ?? "chunks_voyage_4_lite_1024";

// Fallbacks, only for a width query that returns nothing (an empty table on a
// fresh account). These are the figures docs/fusion-egress-plan.md §0 quotes.
const FALLBACK_WIDTHS = { chunkText: 2388, overrideVec: 11414, cacheRow: 24577, simRow: 45, annRow: 60 };

type WidthKey = keyof typeof FALLBACK_WIDTHS;

// Each tracked statement family. `ilike` clauses are ANDed and `unlike` ones
// negated; pg_stat_statements holds one row per (user, database, queryid), so
// the same normalised statement appears several times and every pattern is
// SUMmed rather than read as one row.
//
// Patterns match the statement with its whitespace collapsed (see `NORMALISED`):
// pg_stat_statements stores the source text verbatim, newlines and template
// indentation included, so a pattern written on one line matches nothing at all
// against the raw column.
type Pattern = {
  key: string;
  label: string;
  width: WidthKey;
  ilike: string[];
  unlike?: string[];
  headline: boolean;
};

const PATTERNS: Pattern[] = [
  {
    key: "deep_pool",
    label: "deep pool  (queryExcluding: text on all deepN rows)",
    width: "chunkText",
    ilike: ["select id, document_id, position, text,%", "%from \"chunks_%", "%not (id = any(%"],
    headline: true,
  },
  {
    key: "override_vectors",
    label: "override vectors  (overrideEmbeddings: every piece, per query)",
    width: "overrideVec",
    ilike: ["select source_chunk_id, embedding from config_chunk_overrides%"],
    headline: true,
  },
  {
    // Phase 2's replacement for it (§1.1): Postgres collapses the pieces to one
    // sim per overridden chunk. Tracked beside the statement it replaces so the
    // phase is graded on bytes MOVED, not merely on the old counter going quiet —
    // the same reason resolve_chunks is tracked below. The call count is EXPECTED
    // to rise: one query per question per model, where the old read was one per
    // fingerprint.
    key: "override_sims",
    label: "override sims  (overrideSims: one float per chunk, in SQL)",
    width: "simRow",
    // NB the literal `1` in `1 - (...)` is NORMALISED to a parameter by
    // pg_stat_statements, so a pattern that spells it out matches nothing —
    // the same silent-zero failure mode as phase 1's whitespace trap.
    ilike: [
      "select source_chunk_id, max(%",
      "%from config_chunk_overrides%",
      "%group by source_chunk_id%",
    ],
    headline: true,
  },
  {
    // Phase 3's replacement for the deep pool (§1.2): the same ANN, the same
    // deepN rows, without the text column. Tracked beside the statement it
    // replaces for the same reason override_sims is — a phase is graded on bytes
    // MOVED, not on an old counter going quiet.
    key: "deep_pool_ids",
    label: "deep pool  (queryExcludingIds: id + score, no text)",
    width: "annRow",
    // pg_stat_statements normalises the literal `1` in `1 - (...)`, so the
    // select list is matched by its two real columns and not by the expression.
    ilike: ["select id, % as score from \"chunks_%", "%not (id = any(%"],
    // LOAD-BEARING: `select id, %` also matches the text-carrying variant above
    // (`select id, document_id, position, text, ...`), which would double-count
    // phase 3's saving into its own replacement. `position` is the column the
    // light read dropped and the text read cannot omit.
    unlike: ["%position%"],
    headline: true,
  },
  {
    // Phase 3 does not delete the deep pool's text, it MOVES it here: the meta
    // map starts empty and the topK that survive are resolved by id. Tracking it
    // is what stops phase 3 from grading itself on a saving it only relocated.
    key: "resolve_chunks",
    label: "resolved text  (resolveChunks: text by id, topK-shaped)",
    width: "chunkText",
    ilike: ["select id, document_id, position, text from \"chunks_%", "%id = any(%"],
    unlike: ["%not (id = any(%"],
    headline: false,
  },
  {
    // History, kept as a tripwire. Part 1 of docs/egress-reduction-plan.md made
    // this a one-row read; a rising count here means that fix has come undone.
    key: "cache_probe",
    label: "cache probe  (already fixed — expect ~0 rows)",
    width: "cacheRow",
    ilike: ["select query_text, query_vector%", "%from semantic_cache%"],
    headline: false,
  },
];

type Reading = { key: string; calls: number; rows: number };
type Snapshot = {
  at: string;
  label: string;
  statsReset: string | null;
  widths: Record<WidthKey, number>;
  readings: Reading[];
};

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

// Average bytes on the wire for one row of each family. octet_length over the
// TEXT rendering is what matters: a real[] vector reaches the app as its text
// form, which is ~4.5x the 4 bytes a float occupies on disk.
async function measureWidths(): Promise<Record<WidthKey, number>> {
  const [chunk] = await sql<{ w: number | null }[]>`
    select avg(octet_length(text))::int as w from ${sql(CHUNKS_TABLE)}`;
  const [ovr] = await sql<{ w: number | null }[]>`
    select avg(octet_length(embedding::text))::int as w from config_chunk_overrides`;
  const [cache] = await sql<{ w: number | null }[]>`
    select avg(octet_length(query_text) + octet_length(query_vector::text) + octet_length(result::text))::int as w
    from semantic_cache`;
  return {
    chunkText: chunk?.w ?? FALLBACK_WIDTHS.chunkText,
    overrideVec: ovr?.w ?? FALLBACK_WIDTHS.overrideVec,
    cacheRow: cache?.w ?? FALLBACK_WIDTHS.cacheRow,
    // Not measured from a table — this row exists only in a result set: a uuid
    // (36 B) plus a float rendered as text. Fixed, and small enough that being a
    // few bytes out cannot change a phase's verdict.
    simRow: FALLBACK_WIDTHS.simRow,
    // Same reasoning as simRow, one column wider in spirit: a uuid plus a
    // double rendered as text. Also result-set-only, also too small to move a
    // verdict.
    annRow: FALLBACK_WIDTHS.annRow,
  };
}

// pg_stat_statements' `query` with runs of whitespace collapsed, so a pattern
// can be written the way the statement reads rather than the way it is indented.
const NORMALISED = sql`regexp_replace(btrim(query), '\\s+', ' ', 'g')`;

async function read(p: Pattern): Promise<Reading> {
  const clauses = [
    ...p.ilike.map((pat) => sql`${NORMALISED} ilike ${pat}`),
    ...(p.unlike ?? []).map((pat) => sql`${NORMALISED} not ilike ${pat}`),
  ];
  const where = clauses.reduce((acc, c) => sql`${acc} and ${c}`);
  const [row] = await sql<{ calls: string | null; rows: string | null }[]>`
    select sum(calls) as calls, sum(rows) as rows from pg_stat_statements where ${where}`;
  return { key: p.key, calls: Number(row?.calls ?? 0), rows: Number(row?.rows ?? 0) };
}

async function snapshot(label: string, widths?: Record<WidthKey, number>): Promise<Snapshot> {
  const [meta] = await sql<{ stats_reset: Date | null }[]>`
    select stats_reset from pg_stat_statements_info`;
  return {
    at: new Date().toISOString(),
    label,
    statsReset: meta?.stats_reset ? meta.stats_reset.toISOString() : null,
    widths: widths ?? (await measureWidths()),
    readings: await Promise.all(PATTERNS.map(read)),
  };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} kB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function print(rows: { p: Pattern; calls: number; rows: number; bytes: number }[], title: string): void {
  console.log(`\n${title}`);
  console.log("  " + "statement".padEnd(52) + "calls".padStart(9) + "rows".padStart(11) + "bytes".padStart(12));
  for (const r of rows) {
    console.log(
      "  " +
        r.p.label.padEnd(52) +
        String(r.calls).padStart(9) +
        String(r.rows).padStart(11) +
        (r.bytes >= 1024 * 1024 ? mb(r.bytes) : kb(r.bytes)).padStart(12),
    );
  }
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  console.log("  " + "TOTAL estimated egress".padEnd(52) + "".padStart(20) + mb(total).padStart(12));
}

function tabulate(after: Snapshot, before?: Snapshot) {
  const widths = before?.widths ?? after.widths;
  return PATTERNS.map((p) => {
    const a = after.readings.find((r) => r.key === p.key)!;
    const b = before?.readings.find((r) => r.key === p.key);
    const rows = a.rows - (b?.rows ?? 0);
    // A baseline taken by an EARLIER build has no width for a pattern added
    // since. Fall back rather than multiplying by undefined and printing NaN —
    // a phase-1 baseline has to stay usable for phase 2's report.
    const width = widths[p.width] ?? after.widths[p.width] ?? FALLBACK_WIDTHS[p.width];
    return { p, calls: a.calls - (b?.calls ?? 0), rows, bytes: rows * width };
  });
}


// --- the fixed walk ----------------------------------------------------------
//
// §2 grades every phase against ONE walk, so the walk has to be the same walk
// each time. This is the retrieval half of a re-score, replayed from the master's
// eval questions in a fixed order, and it WRITES NOTHING: no results, no run row,
// no baseline leg. A phase is graded on bytes, and a read-only replay moves the
// same bytes as the scoring run it is cut from while leaving the live board alone
// — the real re-score, with its metrics, is phase 4's browser check.
//
// It costs $0 by construction: only questions whose vector is already in
// eval_question_embeddings are replayed, so nothing is ever embedded.
//
// Two legs, because the two costs do not fall on the same operation (§0):
//   rescore  — one shared context, so the piece cache is warm and the pool text
//              dominates. This is what "Re-score all" does.
//   autotune — a fresh context per question, so every piece vector is re-read.
//              This is what a confirm-per-rung autotune does when the changed
//              fingerprint evicts that cache.
const WALK_DEFAULT_N = 25;

type WalkQuestion = { questionId: string; question: string };

async function walkQuestions(n: number): Promise<WalkQuestion[]> {
  const cfg = activeConfig();
  // Ordered by id, not by created_at or random: the walk has to select the SAME
  // questions in a later phase, on a board that has gained questions since.
  const rows = await scoped<{ question_id: string; question: string }[]>`
    select distinct q.id as question_id, q.question
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${cfg.id}
    order by q.id
  `;
  const vectors = await getCachedQueryEmbeddings(
    rows.map((r) => r.question_id),
    cfg.embeddingModel,
  );
  return rows
    .filter((r) => vectors.has(r.question_id))
    .slice(0, n)
    .map((r) => ({ questionId: r.question_id, question: r.question }));
}

async function runWalk(n: number): Promise<void> {
  const owner = await loadOwner(sql);
  await inScope(owner, async () => {
    const cfg = activeConfig();
    const questions = await walkQuestions(n);
    if (questions.length === 0) throw new Error("no questions with a cached vector to replay");
    const vectors = await getCachedQueryEmbeddings(
      questions.map((q) => q.questionId),
      cfg.embeddingModel,
    );
    const depth = retrievalDepth(await getActiveCriteria(), cfg.topK);

    console.log(
      `walk: config ${CONFIG_ID.slice(0, 8)} — ${questions.length} questions at depth ${depth}, $0 (all vectors cached)`,
    );

    // Re-score leg: one context, one fingerprint, warm piece cache.
    const statePromise = retrievalStateFingerprint();
    const ctx = await buildRetrievalContext(statePromise);
    for (const q of questions) {
      await retrieveWithCutoffs(q.question, vectors.get(q.questionId)!, depth, ctx);
    }

    // Autotune leg: no fingerprint, so each context re-reads the pieces itself.
    for (const q of questions) {
      const fresh = await buildRetrievalContext();
      await retrieveWithCutoffs(q.question, vectors.get(q.questionId)!, depth, fresh);
    }
  });
}

function loadState(): Snapshot {
  if (!existsSync(STATE)) throw new Error(`no baseline at ${STATE} — run: npm run egress -- start "<label>"`);
  return JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
}

async function main(): Promise<void> {
  const [cmd = "show", ...rest] = process.argv.slice(2);
  const label = rest.join(" ").trim();

  if (cmd === "start") {
    const snap = await snapshot(label || "unnamed walk");
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(snap, null, 2) + "\n");
    console.log(`baseline "${snap.label}" taken ${snap.at} -> ${STATE}`);
    console.log(
      `  widths: chunk text ${snap.widths.chunkText} B, override vector ${snap.widths.overrideVec} B, ` +
        `cache row ${snap.widths.cacheRow} B`,
    );
    print(tabulate(snap), "cumulative since stats_reset " + (snap.statsReset ?? "unknown"));
    console.log("\nrun the walk, then: npm run egress -- report");
  } else if (cmd === "report") {
    const before = loadState();
    const after = await snapshot(before.label, before.widths);
    const rows = tabulate(after, before);
    // pg_stat_statements evicts least-used entries when it hits pg_stat_statements.max.
    // A negative delta means the baseline's entry was evicted mid-walk, so the
    // delta is not a measurement of anything and must not be reported as one.
    if (rows.some((r) => r.rows < 0 || r.calls < 0)) {
      console.log("WARNING: a counter went backwards — an entry was evicted or stats were reset.");
      console.log("         Re-take the baseline and re-run the walk; this delta is not usable.");
    }
    if (after.statsReset !== before.statsReset) {
      console.log(`WARNING: stats_reset moved (${before.statsReset} -> ${after.statsReset}). Delta invalid.`);
    }
    print(rows, `walk "${before.label}" — ${before.at} to ${after.at}`);
    const head = rows.filter((r) => r.p.headline);
    console.log(
      "\n  headline: " +
        head.map((r) => `${r.p.key}=${r.rows} rows`).join(", ") +
        `, total ${mb(rows.reduce((a, r) => a + r.bytes, 0))}`,
    );
  } else if (cmd === "walk") {
    const n = Number(rest[0] ?? WALK_DEFAULT_N);
    const before = await snapshot(`fixed walk, ${n} questions`);
    await runWalk(n);
    const after = await snapshot(before.label, before.widths);
    print(tabulate(after, before), `walk "${before.label}"`);
  } else if (cmd === "show") {
    const snap = await snapshot("cumulative");
    print(tabulate(snap), "cumulative since stats_reset " + (snap.statsReset ?? "unknown"));
  } else {
    throw new Error(`unknown command "${cmd}" — expected start | report | show`);
  }

  await sql.end();
}

void main();
