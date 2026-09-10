// THE REPLAY STORE'S PAYLOAD SHAPES — phase 1 of docs/demo-cache-replay-plan.md.
//
// `demo_replay.payload` (0080) is jsonb written by one process (the publish) and
// read by another (a guest's request), which is the seam where a field silently
// stops being written and nothing notices until a visitor's leaderboard is short
// a column. So the three kinds get one module that names them.
//
// SPLIT OUT OF replay.ts FOR THE REASON pairBankCore IS SPLIT OUT OF pairBank:
// this half touches no database and no request scope, so it is unit-testable on
// its own, while the half that opens a transaction is not. Nothing here imports
// "server-only" or lib/db, and it should stay that way.
import { createHash } from "node:crypto";

import { pairKey, type PairDifficultyLike, type PairLabelLike } from "@/lib/rag/keyModelSweepCore";

// The single matrix row's key. A constant rather than an empty string so the
// three kinds read alike at every call site, and so a second matrix (a second
// pooled set, if one ever exists) has somewhere to go without a migration.
export const MATRIX_KEY = "pooled";

// The single progress row's key — how far the generate slider has advanced.
export const PROGRESS_KEY = "pairs";

// The single board row's key. Named for what it holds rather than left empty,
// on MATRIX_KEY's argument: a second scope (a second board, if the demo ever
// walks two) has somewhere to go without a migration.
export const BOARD_KEY = "chunks";

// STABLE IDENTITY, and it is the one thing phase 1 has to get right. The matrix
// is banked in the master's order and subsetted by "the first n", so that n must
// mean the SAME n pairs on both sides of the clone and across both publish hops
// (master → seed → guest). Position alone cannot promise that — a re-publish
// with one extra pair would shift every index — so each pair carries a hash of
// its own two texts and the order is data, not an accident of a query plan.
//
// Over `pairKey`, which is UNORDERED (lower text first): a pair is unordered
// everywhere else in the sweep — insertPairs canonicalises by hash and a shadow
// row's (new_query, matched_query) can arrive either way round — so an identity
// that distinguished the two orientations would call one pair two.
export const pairIdentity = (textA: string, textB: string): string =>
  createHash("sha256").update(pairKey(textA, textB), "utf8").digest("hex").slice(0, 32);

// A banked pair: everything about it EXCEPT its text, which is the whole point.
// The demo ships no pair rows any more, so nothing here can be turned back into
// a question a guest could read — and nothing downstream needs to, because every
// number on the page is a function of the sims and the labels.
export type ReplayPair = {
  // pairIdentity(textA, textB). Not read on the happy path — the order is — but
  // it is what lets a re-publish be diffed against the last one, and what a
  // banked shadow verdict joins to.
  hash: string;
  label: PairLabelLike;
  source: "shadow" | "generated";
  // shadow only, and load-bearing: poolPairs resolves a generated/shadow
  // collision differently for `probe` than for `traffic` (the F3 rule).
  origin?: "traffic" | "probe";
  // generated only.
  difficulty: PairDifficultyLike | null;
  // Whether F3's screen contradicted the generator's label. Carried rather than
  // dropped because the demo's screen button RESOLVES it: a guest generates
  // pairs unscreened, and screening is what admits them to the sweep.
  quarantined: boolean;
};

// THE MATRIX ITSELF. `sims` is parallel to `models` in the outer index and to
// `pairs` in the inner one — a rectangle, not a map — because that is both the
// smallest JSON encoding of it and the shape the readers want: one model's
// column, subsetted to the first n, is `sims[m].slice(0, n)`.
//
// A model that failed to score is `null` rather than a row of zeros, so an
// unreachable provider at publish time cannot masquerade as a model that scored
// every pair at no similarity.
export type ReplayMatrix = {
  version: 1;
  // The candidate list in the order the sweep ran it, so a replayed leaderboard
  // is in the master's order rather than the config's current one.
  models: string[];
  pairs: ReplayPair[];
  sims: (number[] | null)[];
  // The sweep's own inputs, banked because they are settings rather than
  // measurements and the guest's copy of them is a clone artifact: reading them
  // back from the guest's config would let a rewritten setting silently restate
  // what the master measured.
  target: number;
  minSamples: number;
};

// How far this guest has advanced, and whether they have screened. The ONLY
// mutable kind: a guest's clicks write here and nowhere else.
export type ReplayProgress = {
  // How many of the matrix's GENERATED pairs the visitor has reached. The
  // shadow half is theirs already — the clone carries the judged rows — so it is
  // never rationed.
  generated: number;
  // Generate leaves pairs unscreened; screening admits them to the sweep. False
  // means the quarantine over the current n is unresolved.
  screened: boolean;
};

// THE BOARD — phase 2 of docs/demo-real-flow-plan.md, and the only kind here
// that is about the Eval tab rather than the caching lane.
//
// Which chunks the demo's workbench is scoped to: the ~30 the publish chose, in
// document order, and nothing else. It replaces what the frozen set was carrying
// — the dashboard's split, the demo banner, and the server-side chunk list — for
// the build that empties the board, where there are no frozen questions left to
// derive a scope from.
//
// IDS, NOT A COUNT OR A QUERY. The selection is made once at publish time
// (lib/demo/tunable) against scores that will not exist in the guest's workspace
// in the same shape, so re-deriving it per workspace would re-roll it; and a
// count would leave every reader to pick its own thirty.
export type ReplayBoard = {
  version: 1;
  // Chunk ids in the READER's own id space: clone step 5g remaps them on each
  // hop, exactly as it remaps an ideal's chunk_ids.
  chunks: string[];
};

// THE BANKED RANKINGS — phase 5 of docs/demo-real-flow-plan.md, and the Eval
// tab's second and third kinds after the board.
//
// `ndcg_ideal` is the master's cross-model aggregate order per question;
// `llm_ranking` is the llm_rerank order bought on the master at publish time.
// ONE SHAPE FOR BOTH, because they are the same artifact seen twice: an ordered
// list of chunk ids belonging to a question, replayed into a guest's workspace
// as an eval_rankings row instead of being computed there.
//
// KEYED BY THE QUESTION'S TEXT, not by its id and not by (chunk, difficulty).
// The published build ships no eval_questions at all (§3.2) — a guest's rows are
// minted from the bank on their first press — so there is no id on either side
// of the clone to key by. (chunk, difficulty) was the other candidate and it is
// subtly wrong: two questions can share a passage and a difficulty, and the one
// the bank picks is chosen by md5(id) in the SNAPSHOT's id space, so the ideal
// would sometimes belong to the other one. The wording is what the bank carries
// verbatim into the guest's eval_questions row, so hashing it is exact.
export const IDEAL_KEY = "aggregate";
export const LLM_RANKING_KEY = "rerank";

// sha256 of the question text, truncated for the same reason pairIdentity is:
// it is an equality key over a set of tens, not a signature.
export const questionIdentity = (question: string): string =>
  createHash("sha256").update(question, "utf8").digest("hex").slice(0, 32);

export type ReplayRankingEntry = {
  // questionIdentity(question). The join key on the reading side.
  q: string;
  // Chunk ids in the READER's own id space, best first. NULL HOLDS A PLACE: an
  // id that failed the clone's remap stays in the array as null, because here
  // position is rank and dropping an element would promote everything behind it.
  order: (string | null)[];
};

export type ReplayRankings = {
  version: 1;
  entries: ReplayRankingEntry[];
};

// What the two ranking kinds may weigh, on DEMO_MATRIX_MAX_BYTES' terms exactly
// (reported by scripts/demo-snapshot, never enforced) — except that these are
// read on a BUTTON PRESS rather than on page load, so the bar is looser: 60
// questions × a 30-chunk pool of uuids is ~70 kB and that is the normal case.
export const DEMO_RANKINGS_MAX_BYTES = 250_000;

export const rankingsBytes = (rankings: ReplayRankings): number =>
  Buffer.byteLength(JSON.stringify(rankings), "utf8");

// The verdict the operator's judge really returned for one queued shadow row,
// which clone step 5b blanks and today throws away. Field-for-field the five
// columns it nulls, snake_case because the payload is a row.
export type ReplayShadowVerdict = {
  verdict: string;
  judge_source?: string | null;
  judge_model?: string | null;
  judge_reason?: string | null;
  judged_at?: string | null;
};

// SIMS ARE ROUNDED ON THE WAY IN, at a precision chosen against the readers
// rather than against the disk. A cosine serialises to ~19 characters at full
// double precision, and eleven models over ~345 pairs is ~3,800 of them — 72 kB
// of digits nothing can see. Six places is ~34 kB and is still four orders of
// magnitude finer than the finest distinction any reader draws: τ is chosen on
// the curve's own grid and printed to three places, and calibrateFromJudged
// compares sims only for ordering and for `>= τ`, where a 1e-6 perturbation can
// only re-order pairs that were already indistinguishable.
export const SIM_PRECISION = 1e6;
export const roundSim = (sim: number): number => Math.round(sim * SIM_PRECISION) / SIM_PRECISION;

// What the matrix may weigh before it stops being something to hand a visitor on
// page load. Not enforced — a build that exceeds it is still valid, and refusing
// to publish over a soft limit would be worse than shipping a fat one — but
// scripts/demo-snapshot reports against it, exactly as it does for
// PUBLISHED_SWEEP_MAX_BYTES, because the alternative to noticing here is
// noticing on a visitor's connection.
export const DEMO_MATRIX_MAX_BYTES = 150_000;

export const matrixBytes = (matrix: ReplayMatrix): number =>
  Buffer.byteLength(JSON.stringify(matrix), "utf8");

// Build the banked form. ONE function so the size scripts/demo-snapshot reports
// is the size that is stored: the rounding below is what makes those two numbers
// differ, and a reported number that is not the stored one is worse than none.
//
// THROWS on a ragged rectangle rather than banking one. A `sims` row shorter
// than `pairs` is a publish bug that would surface as a leaderboard quietly
// scoring a different pair set per model, which is the single hardest thing to
// see on the finished page.
export function packMatrix(input: {
  models: string[];
  pairs: ReplayPair[];
  sims: (number[] | null)[];
  target: number;
  minSamples: number;
}): ReplayMatrix {
  if (input.sims.length !== input.models.length) {
    throw new Error(`replay matrix: ${input.sims.length} sim rows for ${input.models.length} models`);
  }
  for (const [i, row] of input.sims.entries()) {
    if (row !== null && row.length !== input.pairs.length) {
      throw new Error(
        `replay matrix: model ${input.models[i]} scored ${row.length} of ${input.pairs.length} pairs`,
      );
    }
  }
  return {
    version: 1,
    models: [...input.models],
    pairs: input.pairs,
    sims: input.sims.map((row) => (row === null ? null : row.map(roundSim))),
    target: input.target,
    minSamples: input.minSamples,
  };
}

// One model's column, or null if it never scored. Read by every replayed number
// on the page, so it is here rather than at three call sites that could each
// drift about what a missing model means.
export function simsFor(matrix: ReplayMatrix, model: string): number[] | null {
  const i = matrix.models.indexOf(model);
  return i === -1 ? null : (matrix.sims[i] ?? null);
}

// THE BANKED TUNING — phase 6 of docs/demo-real-flow-plan.md, and the Eval tab's
// last kind (0083).
//
// One entry per BOARD CHUNK the master autotuned: the winning override it
// confirmed through real retrieval, and the model trials that chunk's "Models
// tried" list reads. A guest's press of ⚙ Auto tune installs these instead of
// searching for them, and then re-scores and reports for real over its own
// questions — the split lib/demo/policy.PUBLISHED_SEARCH_NOTE describes.
//
// A CHUNK THE MASTER NEVER OVERRODE HAS NO ENTRY, and that is a result rather
// than a gap: the master's own search found nothing for it either, so the
// replayed run reports it unresolved exactly as a real one would.
export const TUNING_KEY = "overrides";

// ONE BANK PER DIFFICULTY SET — docs/demo-voyage-tuning-plan.md §3.2.
//
// The master's winners were chosen against the PAIR of questions on each chunk,
// so a guest holding only the easy ones was installing an override confirmed on
// a question it does not have (§0). The publish now banks one tuning row per
// set a guest can hold, keyed by the set: "set:easy", "set:medium",
// "set:easy+medium". Sorted and de-duplicated so the key is a function of the
// set and not of the order the board happened to list it in. TUNING_KEY above is
// the pre-plan key and stays readable as the last fallback, so a build
// published before this plan keeps working.
export const TUNING_SET_PREFIX = "set:";

export function tuningKey(difficulties: readonly string[]): string {
  return TUNING_SET_PREFIX + [...new Set(difficulties)].sort().join("+");
}

// WHICH BANK A GUEST GETS (§3.4), from the keys the shelf actually holds:
//
//   1. the exact key for the difficulties on its board;
//   2. else the smallest banked set that CONTAINS them — a guest holding easy
//      only, on a build that banked just "easy+medium", gets that one, and the
//      guest-side confirm (§3.5) is what keeps a full-set winner honest against
//      the one question it holds;
//   3. else the legacy key, for a build published before the sets existed;
//   4. else nothing — the step then refuses, as it does for an empty shelf.
//
// A pure function of two lists so it can be tested without a store, and so the
// step's log line can name the bank it chose.
export function chooseTuningKey(
  difficulties: readonly string[],
  available: readonly string[],
): string | null {
  const have = new Set(available);
  const exact = tuningKey(difficulties);
  if (have.has(exact)) return exact;
  const wanted = new Set(difficulties);
  let best: { key: string; size: number } | null = null;
  for (const key of available) {
    if (!key.startsWith(TUNING_SET_PREFIX)) continue;
    const set = key.slice(TUNING_SET_PREFIX.length).split("+").filter(Boolean);
    if (![...wanted].every((d) => set.includes(d))) continue;
    if (best === null || set.length < best.size || (set.length === best.size && key < best.key)) {
      best = { key, size: set.length };
    }
  }
  if (best) return best.key;
  return have.has(TUNING_KEY) ? TUNING_KEY : null;
}

// One piece of a banked override — config_chunk_overrides row-for-row, except
// for the vector.
//
// BASE64 FLOAT32, NOT A JSON ARRAY. The board's 30 chunks carry ~72 override
// rows and ~80,000 float4s between them; as JSON numbers that is ~1.6 MB of
// digits, and rounding them (the matrix's answer for cosines) would mean handing
// a visitor a vector the master never confirmed. Little-endian float32 in base64
// is byte-exact against the `real[]` column it came from and ~425 kB.
export type ReplayTuningPiece = {
  // null = the whole base chunk (a model-only override).
  text: string | null;
  dimension: number;
  embedding: string;
  tokenStart: number | null;
  tokenEnd: number | null;
};

// One saved model trial for the chunk, keyed by the QUESTION'S WORDING for
// ReplayRankingEntry's reason exactly: the published build ships no
// eval_questions, so a stored question id names a row that exists in no
// destination. The apply step re-resolves each of these against the guest's own
// board and drops what it cannot find.
//
// `topPool` IS DROPPED ON THE WAY IN. It is the only optional field of the
// stored shape (a trial saved before it existed simply omits it), and carrying
// it would put chunk ids a THIRD level deep in the payload for the clone to
// remap — for a drilldown inside a drilldown of a replayed measurement.
export type ReplayTrialOutcome = {
  question: string;
  storedHit: boolean | null;
  storedRank: number | null;
  newHit: boolean;
  newRank: number;
  newScore: number;
  fusedRank?: number;
  fusedHit?: boolean;
};

export type ReplayTuningTrial = {
  baselineModel: string;
  trialModel: string;
  kind: string;
  chunkSize: number | null;
  chunkOverlap: number | null;
  pieceCount: number | null;
  k: number;
  // The candidate pool, in the READER's id space. A SET, so clone step 5j drops
  // an id that fails to map rather than holding its place — the same rule the
  // board takes and the opposite of a ranking's.
  pool: string[];
  results: ReplayTrialOutcome[];
};

export type ReplayTuningEntry = {
  // The chunk this override belongs to, in the READER's id space (step 5j).
  chunk: string;
  model: string;
  kind: "model" | "size" | "size+model";
  // The change-log phrasing the master's own run would have written, so a
  // guest's retrieval-change list reads like a real run's rather than like a
  // copy ("re-split at 400 tokens under voyage-3.5" and not "delegate → …").
  detail: string;
  pieces: ReplayTuningPiece[];
  trials: ReplayTuningTrial[];
};

export type ReplayTuning = {
  version: 1;
  entries: ReplayTuningEntry[];
};

// float32 little-endian, base64. One pair of functions rather than an encode at
// the publish and a decode at the press, because a mismatch between them is a
// vector that ranks like noise and looks like a bad autotune.
export const packEmbedding = (embedding: number[]): string =>
  Buffer.from(new Float32Array(embedding).buffer).toString("base64");

export const unpackEmbedding = (packed: string): number[] => {
  const bytes = Buffer.from(packed, "base64");
  // COPIED OUT of the Buffer's pool rather than viewed in place: Node hands
  // small Buffers a shared ArrayBuffer at an arbitrary byteOffset, and
  // Float32Array requires a multiple-of-4 one — so the view throws for some
  // payloads and not others, which is the worst kind of intermittent.
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return [...new Float32Array(copy)];
};

// What the tuning kind may weigh, on DEMO_RANKINGS_MAX_BYTES' terms: reported by
// scripts/demo-snapshot, never enforced, and looser than the matrix's because it
// is read on a button press rather than on page load. ~425 kB of vectors is the
// normal case for a 30-chunk board, so this bar is set above it rather than at
// an aspiration nobody can meet.
export const DEMO_TUNING_MAX_BYTES = 700_000;

export const tuningBytes = (tuning: ReplayTuning): number =>
  Buffer.byteLength(JSON.stringify(tuning), "utf8");

// THE BANKED RETRIEVAL — docs/demo-retrieval-bank-plan.md §3.2, and the eighth
// kind (0085).
//
// One row per PORTABLE RETRIEVAL KEY (lib/rag/overrideStore.portableRetrievalKey):
// the 0022 fingerprint with chunk row ids replaced by chunk text hashes, so it
// names an override SET rather than a workspace. Under that key, one entry per
// question the publish's walk scored in that state: the ranked list retrieval
// returned, its scores, and the screen cutoffs the result was judged at. A
// guest's re-score reads the entry instead of retrieving, and inserts a result
// row field-for-field what the computed path would have — lib/rag/eval.ts holds
// that equality and test/integration/demoRetrievalBank.itest.ts asserts it.
//
// TWO FORMS OF ONE PAYLOAD. `hash` is how it is recorded and how the master and
// the snapshot hold it: every id is sha256(chunk text), which names nothing and
// so can be written from any throwaway workspace. `id` is what a guest reads:
// clone step 5l rewrites the hashes into the destination's chunk ids on the hop
// that lands them there, and remaps id → id on any later one (the 5j shape).
// A reader never sees `hash` form — the lookup below refuses it — so a bank
// that skipped the rewrite misses rather than serving hashes as uuids.
export const RETRIEVAL_KIND = "retrieval";

// sha256 of a text, in full — the same 64-hex form clone step 4e's `_hash_scope`
// computes in SQL (`encode(sha256(convert_to(text, 'UTF8')), 'hex')`), because
// the two are joined on the seed → guest hop. Full rather than truncated like
// questionIdentity because this one IS matched against a SQL-side hash, and a
// truncation on one side only is a bank that never hits and never says why.
export const textHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type ReplayRetrievalEntry = {
  // Chunk ids in rank order — READER's id space in `id` form, sha256(chunk text)
  // in `hash` form. NULL HOLDS A PLACE (the 0082 rule): position is rank, and an
  // element the clone could not map stays as null rather than promoting what is
  // behind it. The reader treats any null as a miss for the whole question.
  ids: (string | null)[];
  // Per `ids` entry, the chunk's cosine in its canonical space — the stored
  // order is authoritative, exactly as eval_results.retrieved_scores is.
  scores: number[];
  // retriever.ScreenCutoffs, verbatim: the dirty screen reads these off the
  // inserted row on the NEXT press, so they have to be the real ones.
  cutoffs: { depth: number; deep: number | null; models: Record<string, number> };
};

export type ReplayRetrieval = {
  version: 1;
  form: "hash" | "id";
  // retrievalDepth(criteria, topK) the lists were scored at. A bank at another
  // depth is a bank for another list, and misses whole.
  depth: number;
  // By textHash(question text).
  questions: Record<string, ReplayRetrievalEntry>;
};

// THE PURE LOOKUP, and the fail-closed rules in one place:
//   - the bank must be in `id` form (a hash-form bank reached a reader — the
//     clone skipped the rewrite, or the publish wrote to the wrong account);
//   - the bank's depth must be the depth this score is retrieving at;
//   - the question's text must be banked;
//   - no element of the list may be null (a chunk that did not travel).
// Any of those is a miss, which is the ordinary computed path — never a wrong
// number. Returns the entry with `ids` narrowed to strings.
export function bankedRetrieval(
  bank: ReplayRetrieval | null,
  question: string,
  depth: number,
): { ids: string[]; scores: number[]; cutoffs: ReplayRetrievalEntry["cutoffs"] } | null {
  if (bank === null || bank.form !== "id" || bank.depth !== depth) return null;
  const entry = bank.questions[textHash(question)];
  if (!entry) return null;
  if (entry.ids.some((id) => id === null)) return null;
  if (entry.scores.length !== entry.ids.length) return null;
  return { ids: entry.ids as string[], scores: entry.scores, cutoffs: entry.cutoffs };
}

// ONE RECORDED RETRIEVAL — the NDJSON line lib/rag/retrievalRecord appends per
// computed (never banked) result while the publish's walk runs. `ids` are text
// hashes: the recorder hashes the retrieved chunks' text in-process, so the
// line names nothing that belongs to the workspace it was written from.
export type RetrievalRecord = {
  key: string;
  q: string;
  depth: number;
  ids: string[];
  scores: number[];
  cutoffs: ReplayRetrievalEntry["cutoffs"];
};

// MERGE THE WALK'S LINES INTO ONE PAYLOAD PER KEY (hash form). Nine walks
// record the same (key, question) many times — every confirm re-scores the
// same handful before and after, and every guest's Score pending records the
// 'baseline' state — so duplicates have to be reconciled, and the first walk
// (2026-09-08, 499 lines) showed exactly what they look like:
//
//   - THE RANKS AGREE AND THE SCORES DRIFT, by ≤ 0.0022, across GUESTS. Each
//     guest embeds its questions afresh, and the provider's query vectors are
//     not bit-identical call to call, so two guests measure the same list with
//     cosines a few thousandths apart. That is not two states under one key: it
//     is one state seen through two real query vectors, and two real guests
//     already differ from each other by exactly this much. The first recording
//     is kept, and a drift over SCORE_TOLERANCE — an order of magnitude past
//     anything observed — is still a defect and still throws.
//   - THE RANKS DISAGREE, once in 420: a near-tie at the last rank that the same
//     drift flipped. The bank cannot call either list exact for both guests, so
//     the question is NOT banked under that key (`contested`) and every guest
//     computes it — the fail-closed answer, and one that costs a single
//     question's retrieval rather than a wrong rank under a real-looking bar.
//
// Depth is the one rule with no tolerance: one key, one depth, or the key is
// broken.
export const SCORE_TOLERANCE = 0.01;

const within = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= SCORE_TOLERANCE;

function sameEntry(a: ReplayRetrievalEntry, b: ReplayRetrievalEntry): "same" | "drift" | "differ" {
  if (a.ids.length !== b.ids.length || a.ids.some((id, i) => id !== b.ids[i])) return "differ";
  if (a.scores.length !== b.scores.length) return "differ";
  const modelsA = Object.keys(a.cutoffs.models).sort();
  const modelsB = Object.keys(b.cutoffs.models).sort();
  if (a.cutoffs.depth !== b.cutoffs.depth || modelsA.join() !== modelsB.join()) return "differ";
  const drift =
    a.scores.some((s, i) => Math.abs(s - b.scores[i]) > SCORE_TOLERANCE) ||
    !within(a.cutoffs.deep, b.cutoffs.deep) ||
    modelsA.some((m) => !within(a.cutoffs.models[m], b.cutoffs.models[m]));
  if (drift) return "differ";
  return JSON.stringify(a) === JSON.stringify(b) ? "same" : "drift";
}

export function packRetrieval(records: RetrievalRecord[]): {
  banks: Map<string, ReplayRetrieval>;
  // (key, question) pairs recorded with two different RANK lists, and so left
  // out of the bank. Keys and question hashes, for the census line.
  contested: { key: string; q: string }[];
} {
  const out = new Map<string, ReplayRetrieval>();
  const contested = new Map<string, { key: string; q: string }>();
  for (const r of records) {
    let bank = out.get(r.key);
    if (!bank) {
      bank = { version: 1, form: "hash", depth: r.depth, questions: {} };
      out.set(r.key, bank);
    }
    if (bank.depth !== r.depth) {
      throw new Error(
        `retrieval bank ${r.key.slice(0, 8)}: recorded at depth ${bank.depth} and ${r.depth}`,
      );
    }
    const entry: ReplayRetrievalEntry = { ids: r.ids, scores: r.scores, cutoffs: r.cutoffs };
    const id = `${r.key}\n${r.q}`;
    if (contested.has(id)) continue;
    const have = bank.questions[r.q];
    if (!have) {
      bank.questions[r.q] = entry;
      continue;
    }
    if (sameEntry(have, entry) === "differ") {
      delete bank.questions[r.q];
      contested.set(id, { key: r.key, q: r.q });
    }
    // "same" and "drift" both keep the first recording.
  }
  return { banks: out, contested: [...contested.values()] };
}

// What the retrieval kind may weigh per GUEST across every key, on
// DEMO_TUNING_MAX_BYTES' terms (reported by scripts/demo-snapshot, never
// enforced): §3.2 estimates ~400 kB — ~10 full states of ~60 questions plus
// ~60 confirm-intermediate states of one or two.
export const DEMO_RETRIEVAL_MAX_BYTES = 700_000;

export const retrievalBytes = (banks: Iterable<ReplayRetrieval>): number => {
  let n = 0;
  for (const b of banks) n += Buffer.byteLength(JSON.stringify(b), "utf8");
  return n;
};
