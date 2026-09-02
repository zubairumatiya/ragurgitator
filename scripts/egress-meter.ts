// FUSION EGRESS — the measuring instrument (docs/fusion-egress-plan.md §2).
//
//   npm run egress -- start "master re-score"   snapshot before a walk
//   npm run egress -- report                    snapshot after it, print the delta
//   npm run egress -- show                      cumulative totals, no delta
//   npm run egress -- walk [leg] [n]            run one walk leg and grade it
//
// `leg` is retrieval | jobs | screen | fingerprint | picker | all, and defaults
// to `retrieval` when the first argument is a number or absent — so every command
// in the predecessor's log (`walk`, `walk 25`) still means what it meant.
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
import type { ChangedChunk } from "../lib/rag/eval";
import { screenAffectedQuestions } from "../lib/rag/eval";
import { getCachedQueryEmbeddings, getChunksByIds } from "../lib/rag/evalStore";
import { retrievalStateFingerprint } from "../lib/rag/overrideStore";
import { getRankingChunks } from "../lib/rag/rankingStore";
import { buildRetrievalContext, retrieveWithCutoffs } from "../lib/rag/retriever";
import { getJob, listJobs } from "../lib/jobs/store";
import { sql as scoped } from "../lib/db";
import { CONFIG_ID, inScope, loadOwner, type Owner } from "./lib/followup";

// Outside the repo's tracked tree (data/ is gitignored) — a baseline is a local
// measurement, not a source file, and two people's baselines must not collide.
const STATE = process.env.EGRESS_STATE ?? "data/egress-meter.json";

// The demo master's chunk table. Widths are measured here because this is the
// config the loops run against and therefore the config whose rows the numbers
// below are made of.
const CHUNKS_TABLE = process.env.EGRESS_CHUNKS_TABLE ?? "chunks_voyage_4_lite_1024";

// Fallbacks, only for a width query that returns nothing (an empty table on a
// fresh account). These are the figures docs/fusion-egress-plan.md §0 quotes.
const FALLBACK_WIDTHS = {
  chunkText: 2388,
  overrideVec: 11414,
  cacheRow: 24577,
  simRow: 45,
  annRow: 60,
  // docs/demo-egress-plan.md §0's measured widths, used only when the live table
  // is empty. jobRowLight is jobRow minus `cursor` — 5,999 - 5,811.
  jobRow: 5999,
  jobRowLight: 188,
  cacheVec: 12151,
  qVec: 10916,
  fpRow: 110,
  // Result-set-only rows, so measured by arithmetic rather than from a table
  // (the same reasoning as simRow/annRow below).
  //   poolSim  — uuid(36) + 64-char hash + two doubles rendered as text (~40).
  //   preview  — uuid(36) + file name + position + left(text, 200).
  poolSimRow: 140,
  previewRow: 260,
  //   screenSim — two uuids (36 each) plus a double rendered as text (~20).
  screenSimRow: 92,
  //   fpDigest  — one row, 64 hex characters, whatever the pieces table holds.
  fpDigest: 64,
};

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
    // --- docs/demo-egress-plan.md §2 -------------------------------------
    // Item E. The panel/poller/guard read; `cursor` is 5,811 B of the 5,999.
    // The select list is spelled out to its sixth column because that is where
    // the light list (phase 1) diverges — `..., scope, cursor, result` becomes
    // `..., scope, result`, so the two forms are mutually exclusive patterns and
    // the saving shows up as bytes MOVED between them, not as a counter going
    // quiet. claimJob's `update ... returning` is deliberately NOT matched: it
    // keeps the cursor and it is not the read this plan is about.
    key: "job_rows",
    label: "job rows  (JOB_COLUMNS: cursor on every listed job)",
    width: "jobRow",
    ilike: ["select id, config_id, config_label, kind, status, scope, cursor,%", "%from background_jobs%"],
    headline: true,
  },
  {
    // Phase 1's replacement, tracked beside what it replaces (§2).
    key: "job_rows_light",
    label: "job rows  (JOB_COLUMNS_LIGHT: no cursor)",
    width: "jobRowLight",
    ilike: ["select id, config_id, config_label, kind, status, scope, result,%", "%from background_jobs%"],
    headline: false,
  },
  {
    // Item C. The free-competitor lookup: a full 1,024-float vector per deeper
    // candidate, up to 150 a query on a warm cache.
    key: "doc_vectors",
    label: "doc vectors  (cachedDocVectors: a vector per free candidate)",
    width: "cacheVec",
    // 0084 made the column pgvector, so the read asks for ::real[] by name;
    // pg_stat_statements keeps the projection verbatim, so match on that.
    ilike: ["select text_hash, embedding::real[] as embedding from embedding_cache%"],
    headline: true,
  },
  {
    // Item D. Every labelled question's query vector, for a cosine the database
    // could have done.
    key: "question_vectors",
    label: "question vectors  (getCachedQueryEmbeddings: 1,024 floats each)",
    width: "qVec",
    ilike: ["select eval_question_id, embedding from eval_question_embeddings%"],
    headline: true,
  },
  {
    // Phase 2's replacement for doc_vectors AND for the deep pool's text (§1.2):
    // the ANN joined to embedding_cache on sha256(text), returning the sim.
    // Tracked beside both, so phase 2 is graded on bytes moved.
    key: "pool_sims",
    label: "pool sims  (queryExcludingWithSims: id, score, hash, msim)",
    width: "poolSimRow",
    // Every numeric literal in `1 - (... <=> ...)` is parameterised by
    // pg_stat_statements, so the pattern is anchored on the column ALIASES the
    // projection introduces and never on the expression that produces them.
    ilike: ["select p.id,%", "%as text_hash,%", "%as msim%", "%from \"chunks_%"],
    headline: true,
  },
  {
    // Phase 4's replacements for question_vectors, override_vectors and the
    // screen leg's share of doc_vectors (§1.4): two doubles per (question,
    // changed chunk) pair instead of two 1,024-float vectors. Two keys, not the
    // one D6 asked for, because the screen asks two different questions —
    // §4 D15. Both are anchored on the column ALIASES, since pg_stat_statements
    // parameterises the `1` in `1 - (...)` and every other literal.
    key: "screen_base_sims",
    label: "screen base sims  (screenSims: question x changed chunk, in SQL)",
    width: "screenSimRow",
    ilike: [
      "select qe.eval_question_id as question_id,%",
      "%as chunk_id,%",
      "%from eval_question_embeddings qe%",
    ],
    // LOAD-BEARING: the SAME-SPACE piece statement also selects
    // `qe.eval_question_id as question_id` from `eval_question_embeddings qe`
    // (its query vector is the base one), so without this it lands in both keys
    // and the base lane reads ~2x its real rows. `max(` is the aggregate only
    // the piece form has. Measured: 22,656 rows became 11,800.
    unlike: ["%max(%"],
    headline: false,
  },
  {
    key: "screen_piece_sims",
    label: "screen piece sims  (screenSims: best piece per pair, in SQL)",
    width: "screenSimRow",
    ilike: ["%as question_id,%", "%as chunk_id, max(%", "%config_chunk_overrides o%"],
    headline: false,
  },
  {
    // Item I. 274 piece rows per fingerprint, 8,668 fingerprints.
    key: "fingerprint_pieces",
    label: "fingerprint pieces  (retrievalStateFingerprint: every piece)",
    width: "fpRow",
    ilike: ["select source_chunk_id, model, kind, piece_index,%", "%from config_chunk_overrides%"],
    headline: true,
  },
  {
    // Phase 6's replacement for it (§1.5): Postgres builds the canonical string
    // and hashes it, so the whole digest is one 64-character row. Tracked beside
    // the statement it replaces for the same reason override_sims is — a phase is
    // graded on bytes MOVED, not on an old counter going quiet.
    key: "fingerprint_digest",
    label: "fingerprint digest  (retrievalStateFingerprint: one hash, in SQL)",
    width: "fpDigest",
    // The `|` separators and the prefix are all NORMALISED to parameters, so the
    // pattern spells out only the function calls that survive normalisation.
    ilike: ["select encode(%", "%sha256(convert_to(%", "%string_agg(%", "%from config_chunk_overrides%"],
    headline: true,
  },
  {
    // Item G, and DELIBERATELY not narrowed by phase 5: getChunksByIds feeds an
    // embed pool, so truncating it would change what gets embedded. Tracked so
    // that a later lap narrowing it by mistake is visible rather than silent.
    key: "chunk_by_id",
    label: "chunk text by id  (getChunksByIds: whole text, on purpose)",
    width: "chunkText",
    ilike: ["select c.id, c.position, c.text, d.file_name%"],
    headline: false,
  },
  {
    // Items G and H, the picker's two readers (getRankingChunks and
    // poolNearest). Phase 5 narrowed getRankingChunks; poolNearest still reads
    // whole text because ranking.ts embeds that pool (see its SQL comment), and
    // getRankingChunks keeps an explicit fullText opt-out for the LLM prompt.
    key: "ranking_text",
    label: "picker text  (poolNearest + fullText opt-out: whole text)",
    width: "chunkText",
    ilike: ["select c.id, d.file_name, c.position, c.text%"],
    headline: true,
  },
  {
    // Phase 5's replacement, tracked beside what it replaces (§2). This is the
    // default getRankingChunks read — everything that renders a ranking.
    key: "ranking_preview",
    label: "picker text  (narrowed: left(c.text, 200))",
    width: "previewRow",
    ilike: ["select c.id, d.file_name, c.position, left(c.text%"],
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
  // The variable-width columns of a job row, and the one of them phase 1 drops.
  // Fixed-width columns (ids, counters, timestamps) are left out on purpose so
  // that jobRow - cursor is exactly jobRowLight and the ratio the plan predicts
  // is the ratio the meter reports.
  const [job] = await sql<{ w: number | null; cursor_w: number | null }[]>`
    select avg(
             octet_length(coalesce(config_label, ''))
             + octet_length(coalesce(scope::text, ''))
             + octet_length(coalesce(cursor::text, ''))
             + octet_length(coalesce(result::text, ''))
             + octet_length(coalesce(last_message, ''))
             + octet_length(coalesce(last_unit_error, ''))
             + octet_length(coalesce(error, ''))
           )::int as w,
           avg(octet_length(coalesce(cursor::text, '')))::int as cursor_w
    from background_jobs`;
  // Sampled, not scanned: embedding_cache is ~17 K rows of ~12 kB text, and an
  // avg() over all of it is a 200 MB server-side read taken twice per leg for a
  // figure whose third digit cannot change a verdict.
  const [cacheVec] = await sql<{ w: number | null }[]>`
    select avg(octet_length(embedding::text))::int as w
    from (select embedding from embedding_cache limit 500) s`;
  const [qvec] = await sql<{ w: number | null }[]>`
    select avg(octet_length(embedding::text))::int as w from eval_question_embeddings`;
  // The fingerprint's projection: no text and no vector, just the seven columns
  // overrideStore.retrievalStateFingerprint selects (md5 renders as 32 chars,
  // the three integers as ~8 each).
  const [fp] = await sql<{ w: number | null }[]>`
    select avg(
             octet_length(source_chunk_id::text) + octet_length(model) + octet_length(kind)
             + 8 + 8 + 8 + 32
           )::int as w
    from config_chunk_overrides`;
  const jobRow = job?.w ?? FALLBACK_WIDTHS.jobRow;
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
    jobRow,
    jobRowLight: jobRow - (job?.cursor_w ?? 0),
    cacheVec: cacheVec?.w ?? FALLBACK_WIDTHS.cacheVec,
    qVec: qvec?.w ?? FALLBACK_WIDTHS.qVec,
    fpRow: fp?.w ?? FALLBACK_WIDTHS.fpRow,
    poolSimRow: FALLBACK_WIDTHS.poolSimRow,
    previewRow: FALLBACK_WIDTHS.previewRow,
    screenSimRow: FALLBACK_WIDTHS.screenSimRow,
    fpDigest: FALLBACK_WIDTHS.fpDigest,
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

// A line whose pattern has no baseline entry is neither a delta nor zero — it is
// UNKNOWN, and null is what says so. See tabulate.
type Row = { p: Pattern; calls: number | null; rows: number | null; bytes: number | null };

const NO_BASELINE = "\u2014 (no baseline)";

function print(rows: Row[], title: string): void {
  console.log(`\n${title}`);
  // Named up front, not buried in the table: a reader who skips the rows still
  // has to learn that the total below is missing some of them.
  const blind = rows.filter((r) => r.rows === null).length;
  if (blind > 0) {
    console.log(`  ${blind} of ${rows.length} patterns have NO BASELINE — shown as "${NO_BASELINE}" and left out`);
    console.log(`  of the total. Re-baseline to measure them: npm run egress -- start "<label>"`);
  }
  console.log("  " + "statement".padEnd(52) + "calls".padStart(9) + "rows".padStart(11) + "bytes".padStart(12));
  for (const r of rows) {
    // 32 = the three numeric columns' widths (9 + 11 + 12), so the placeholder
    // occupies exactly the space the numbers would have.
    const cells =
      r.rows === null || r.calls === null || r.bytes === null
        ? NO_BASELINE.padStart(32)
        : String(r.calls).padStart(9) +
          String(r.rows).padStart(11) +
          (r.bytes >= 1024 * 1024 ? mb(r.bytes) : kb(r.bytes)).padStart(12);
    console.log("  " + r.p.label.padEnd(52) + cells);
  }
  const total = rows.reduce((a, r) => a + (r.bytes ?? 0), 0);
  const caveat = blind > 0 ? `  (${blind} pattern${blind === 1 ? "" : "s"} not counted)` : "";
  console.log("  " + "TOTAL estimated egress".padEnd(52) + "".padStart(20) + mb(total).padStart(12) + caveat);
}

function tabulate(after: Snapshot, before?: Snapshot): Row[] {
  const widths = before?.widths ?? after.widths;
  return PATTERNS.map((p) => {
    const a = after.readings.find((r) => r.key === p.key)!;
    const b = before?.readings.find((r) => r.key === p.key);
    // A baseline taken by an EARLIER build has no READING for a pattern added
    // since, and `- 0` reports that pattern's whole cumulative count since
    // stats_reset as if it were this window's delta. That is what printed a
    // ~432 MB window as 2,848.8 MB and cost two wrong diagnoses before anyone
    // read this line — so an absent baseline is null, never a number.
    //
    // NB `before === undefined` is the CUMULATIVE view (show, and start's
    // opening table), where every line legitimately IS its own full count.
    // Only a PARTIAL baseline can lie, so only that case returns null.
    if (before !== undefined && b === undefined) return { p, calls: null, rows: null, bytes: null };
    const rows = a.rows - (b?.rows ?? 0);
    // A baseline taken by an EARLIER build has no width for a pattern added
    // since. Fall back rather than multiplying by undefined and printing NaN —
    // a phase-1 baseline has to stay usable for phase 2's report.
    const width = widths[p.width] ?? after.widths[p.width] ?? FALLBACK_WIDTHS[p.width];
    return { p, calls: a.calls - (b?.calls ?? 0), rows, bytes: rows * width };
  });
}


// --- the walk, in legs -------------------------------------------------------
//
// §2 grades every phase against ONE walk, so the walk has to be the same walk
// each time. Everything below is read-only — no results, no run row, no baseline
// leg — and costs $0 by construction: only questions whose vector is already in
// eval_question_embeddings are replayed, so nothing is ever embedded.
//
// It is split into LEGS because the original walk exercised retrieval and only
// retrieval: it never listed a background job, never ran the dirty screen and
// never opened the ranking picker, which left four of this plan's seven phases
// with nothing that could falsify them (docs/demo-egress-plan.md §2).
//
//   retrieval    the original walk, both halves (below). Grades phases 2 and 3.
//   jobs         listJobs + getJob, n times.                Grades phase 1.
//   screen       one screenAffectedQuestions over a fixed
//                changed-chunk set.                         Grades phase 4.
//   fingerprint  retrievalStateFingerprint, n times.        Grades phase 6.
//   picker       getChunksByIds + getRankingChunks over a
//                fixed id set.                              Grades phase 5.
//
// `n` means what the leg's own work is measured in: repetitions for the two legs
// that repeat one statement (jobs, fingerprint), and SET SIZE for the three whose
// cost is one call over a set (retrieval's questions, screen's changed chunks,
// picker's ids). Every set is ordered by id so a later phase selects the same
// members from a board that has grown underneath it.
const WALK_DEFAULT_N = 25;

const LEGS = ["retrieval", "jobs", "screen", "fingerprint", "picker"] as const;
type Leg = (typeof LEGS)[number];
const isLeg = (v: string): v is Leg => (LEGS as readonly string[]).includes(v);

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

// The retrieval leg: the retrieval half of a re-score, replayed. Two halves,
// because the two costs do not fall on the same operation (§0):
//   rescore  — one shared context, so the piece cache is warm and the pool text
//              dominates. This is what "Re-score all" does.
//   autotune — a fresh context per question, so every piece vector is re-read.
//              This is what a confirm-per-rung autotune does when the changed
//              fingerprint evicts that cache.
async function legRetrieval(n: number): Promise<void> {
  const cfg = activeConfig();
  const questions = await walkQuestions(n);
  if (questions.length === 0) throw new Error("no questions with a cached vector to replay");
  const vectors = await getCachedQueryEmbeddings(
    questions.map((q) => q.questionId),
    cfg.embeddingModel,
  );
  const depth = retrievalDepth(await getActiveCriteria(), cfg.topK);

  console.log(
    `  retrieval: ${questions.length} questions at depth ${depth}, $0 (all vectors cached)`,
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
}

// The jobs leg: what the background-job panel's poller does, n times. getJob is
// given the newest job so the read is a real single-row fetch and not a miss.
async function legJobs(n: number): Promise<void> {
  const first = await listJobs();
  if (first.length === 0) {
    console.log("  jobs: no background_jobs rows for this owner — the leg reads nothing");
    return;
  }
  const id = first[0].id;
  console.log(`  jobs: ${n} polls of listJobs + getJob over ${first.length} row(s)`);
  for (let i = 0; i < n; i++) {
    await listJobs();
    await getJob(id);
  }
}

// The screen leg: one dirty screen over a fixed changed set — the first n
// overridden chunks of the config, ordered by id so a later phase screens the
// same ones. screenAffectedQuestions writes nothing (its own comment says so),
// and the start state is the live fingerprint, i.e. "the run started now".
async function legScreen(n: number): Promise<void> {
  const cfg = activeConfig();
  const rows = await scoped<{ source_chunk_id: string; model: string }[]>`
    select distinct on (source_chunk_id) source_chunk_id, model
    from config_chunk_overrides
    where config_id = ${cfg.id}
    order by source_chunk_id, piece_index
    limit ${n}
  `;
  if (rows.length === 0) {
    console.log("  screen: no override rows — nothing is changed, so the leg reads nothing");
    return;
  }
  const changed: ChangedChunk[] = rows.map((r) => ({
    chunkId: r.source_chunk_id,
    finalModel: r.model,
    startOverridden: true,
  }));
  const startState = await retrievalStateFingerprint();
  console.log(`  screen: one screenAffectedQuestions over ${changed.length} changed chunk(s)`);
  const screen = await screenAffectedQuestions(changed, startState);
  console.log(`  screen: ${screen.dirty.length}/${screen.total} dirty (read-only, nothing stored)`);
}

// The fingerprint leg: the digest, n times. Nothing memoises it, so n calls are
// n round trips of every override piece row.
async function legFingerprint(n: number): Promise<void> {
  console.log(`  fingerprint: ${n} calls of retrievalStateFingerprint`);
  for (let i = 0; i < n; i++) await retrievalStateFingerprint();
}

// The picker leg: what rendering a graded ranking costs — one getChunksByIds and
// one getRankingChunks over the same fixed id set, which is what the trial page
// does per render.
async function legPicker(n: number): Promise<void> {
  const cfg = activeConfig();
  const table = process.env.EGRESS_CHUNKS_TABLE ?? CHUNKS_TABLE;
  const rows = await scoped<{ id: string }[]>`
    select c.id from ${scoped(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where de.config_id = ${cfg.id}
    order by c.id
    limit ${n}
  `;
  if (rows.length === 0) {
    console.log("  picker: no chunks in this config — the leg reads nothing");
    return;
  }
  const ids = rows.map((r) => r.id);
  console.log(`  picker: getChunksByIds + getRankingChunks over ${ids.length} id(s)`);
  await getChunksByIds(ids);
  await getRankingChunks(ids);
}

const LEG_BODY: Record<Leg, (n: number) => Promise<void>> = {
  retrieval: legRetrieval,
  jobs: legJobs,
  screen: legScreen,
  fingerprint: legFingerprint,
  picker: legPicker,
};

function runLeg(owner: Owner, leg: Leg, n: number): Promise<void> {
  return inScope(owner, () => LEG_BODY[leg](n));
}

// Sum a set of leg deltas into one table, so `walk all` ends on the figure the
// plan's phase 7 actually reports. Bytes are recomputed from the summed rows
// rather than added, so one width change cannot be applied twice.
function combine(legs: Row[][], widths: Record<WidthKey, number>) {
  return PATTERNS.map((p, i) => {
    // `?? 0` cannot fire here: a walk's legs are tabulated against a baseline
    // this same run took, so every pattern has a reading. It is the type's
    // null case, not a real one.
    const calls = legs.reduce((a, l) => a + (l[i].calls ?? 0), 0);
    const rows = legs.reduce((a, l) => a + (l[i].rows ?? 0), 0);
    return { p, calls, rows, bytes: rows * (widths[p.width] ?? FALLBACK_WIDTHS[p.width]) };
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
    if (rows.some((r) => (r.rows ?? 0) < 0 || (r.calls ?? 0) < 0)) {
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
        head.map((r) => `${r.p.key}=${r.rows ?? "no baseline"}`).join(", ") +
        `, total ${mb(rows.reduce((a, r) => a + (r.bytes ?? 0), 0))}`,
    );
  } else if (cmd === "walk") {
    // `walk [leg] [n]`. The leg argument is optional and positional, so a bare
    // number stays a valid first argument and every `walk 25` already written
    // down in the predecessor's log keeps meaning what it meant.
    const [first, second] = rest;
    const named = first !== undefined && (isLeg(first) || first === "all");
    if (first !== undefined && !named && !Number.isFinite(Number(first))) {
      throw new Error(`unknown leg "${first}" — expected ${LEGS.join(" | ")} | all`);
    }
    const which = named ? first : "retrieval";
    const n = Number((named ? second : first) ?? WALK_DEFAULT_N);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`walk: n must be a positive number, got "${n}"`);

    const legs: Leg[] = which === "all" ? [...LEGS] : [which as Leg];
    const owner = await loadOwner(sql);
    console.log(`walk: config ${CONFIG_ID.slice(0, 8)} — ${legs.join(", ")} at n=${n}, $0 (all vectors cached)`);
    // Measured once and reused for every leg's snapshot: the widths are a
    // property of the data, not of the leg, and re-measuring them between legs
    // would make each leg's ruler subtly different from its neighbour's.
    const widths = await measureWidths();
    // Printed because a leg table is only readable next to its ruler: every
    // "bytes" figure below is rows x one of these, and the verification log has
    // to be able to reproduce the arithmetic months later.
    console.log(
      "  widths: " +
        (Object.keys(widths) as WidthKey[]).map((k) => `${k} ${widths[k]} B`).join(", "),
    );
    const tables: Row[][] = [];

    for (const leg of legs) {
      const label = `${leg} leg, n=${n}`;
      const before = await snapshot(label, widths);
      await runLeg(owner, leg, n);
      const after = await snapshot(label, widths);
      const rows = tabulate(after, before);
      if (rows.some((r) => (r.rows ?? 0) < 0 || (r.calls ?? 0) < 0)) {
        console.log("WARNING: a counter went backwards — an entry was evicted or stats were reset.");
        console.log("         Re-take the reading; this delta is not usable.");
      }
      print(rows, `walk "${label}"`);
      tables.push(rows);
    }
    if (tables.length > 1) print(combine(tables, widths), `walk "all legs, n=${n}" — summed`);
  } else if (cmd === "show") {
    const snap = await snapshot("cumulative");
    print(tabulate(snap), "cumulative since stats_reset " + (snap.statsReset ?? "unknown"));
  } else {
    throw new Error(`unknown command "${cmd}" — expected start | report | show | walk`);
  }

  await sql.end();
}

void main();
