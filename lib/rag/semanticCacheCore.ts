// SEMANTIC CACHE — pure core (no DB, no I/O), so it's unit-testable without a
// database connection. This file owns the three decisions that make a hit correct:
//   - spaceOf()             which threshold applies (per embedding vector-space)
//   - bestMatch() / isHit() is the nearest cached query close enough to serve?
//   - fingerprintFrom()     is a cached entry still valid for today's config?
import { createHash } from "node:crypto";

// RELATIVE import on purpose: EMBEDDING_MODELS is a VALUE import, and the test
// runner (node --import tsx) doesn't resolve the "@/" path alias for runtime
// values — only Next's bundler does. embeddingModels.ts is itself dependency-
// free, so this stays importable without a DATABASE_URL.
import { EMBEDDING_MODELS } from "./embeddingModels";
// The τ CHOICE lives in its own import-free module so the UI can run it too —
// see the note there. Re-exported below: this file stays the one place the rest
// of the app imports calibration types from.
import { selectFromCurve, type Attainability, type CurvePoint } from "./calibrationCurve";

export type {
  Attainability,
  AttainabilityBlocker,
  CurvePoint,
  CurveSelection,
} from "./calibrationCurve";
export { selectFromCurve } from "./calibrationCurve";

// Cosine similarity between two same-dimension vectors. Duplicated from
// embedCache.cosine ON PURPOSE: that module imports the DB client at load, so
// importing its cosine would drag the DB into this test-safe core. The math is
// identical — normalize defensively (query and cached vectors are the same
// model, so dims match), 0 on a zero vector.
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export type CacheEntry<T> = { vector: number[]; value: T };

// The nearest cached entry to `queryVec` and its cosine, or null when there are
// no candidates. "Nearest" is by cosine (the whole app compares embeddings this
// way); a tie keeps the first seen. The caller decides whether `sim` clears the
// threshold — this only finds the best match, it doesn't judge it.
export function bestMatch<T>(
  queryVec: number[],
  entries: CacheEntry<T>[],
): { value: T; sim: number } | null {
  let best: { value: T; sim: number } | null = null;
  for (const e of entries) {
    const sim = cosine(queryVec, e.vector);
    if (best === null || sim > best.sim) best = { value: e.value, sim };
  }
  return best;
}

// A hit needs sim AT OR ABOVE threshold. An exact-repeat question lands at
// sim ≈ 1, so it hits under any threshold; the threshold only governs how much
// PARAPHRASE we're willing to treat as the same question.
export function isHit(sim: number, threshold: number): boolean {
  return sim >= threshold;
}

// Which threshold governs a model's hits. Models that emit into the SAME
// cosine-comparable space share one threshold (their similarity scores are on
// the same scale); a model with no vectorSpace tag is its own space. This is
// also why entries are scoped by embedding_model in the DB — a query embedded
// under model A must never be matched against entries from a different space.
export function spaceOf(model: string): string {
  return EMBEDDING_MODELS[model]?.vectorSpace ?? model;
}

// ENTITY / NUMBER GUARD.
//
// Embeddings fail hardest on the tokens that make two identically-phrased
// questions FACTUALLY different: "what was 2023 revenue" vs "what was 2024
// revenue" sits near 0.98 cosine under essentially every model, so no threshold
// that still serves paraphrases can separate them. A lexical failure gets a
// lexical fix rather than a better model.
//
// CONSERVATIVE BY CONSTRUCTION: it can only ever turn a would-be hit into a miss,
// never the reverse. Its worst case is lost savings — which is why a blocked match
// is still shadow-logged (guard_blocked, 0038), so the recall it costs is
// measurable instead of arguable.
//
// Deliberately NO NER model: a dependency and per-lookup latency for a guard whose
// whole job is catching a failure mode regex token sets already catch.

// Numerals, with the decorations that change their meaning: an optional
// currency sign, thousands separators, a decimal part, and a trailing % or
// scale suffix (1.2M, 401k). The scale letter needs (?![a-z]) so "3rd" yields
// "3" rather than swallowing a word boundary.
const NUMERIC_RE = /\$?\d[\d,]*(?:\.\d+)?(?:%|[kmbt](?![a-z]))?/gi;

// ALLCAPS acronyms of length ≥ 2: PTO, EBITDA, Q3, 401K. Must START with a
// letter — a digit-leading token is a numeral and NUMERIC_RE already has it.
const ACRONYM_RE = /\b[A-Z][A-Z0-9]+\b/g;

// Quoted spans — an explicit "this exact string" signal. Double and curly
// quotes ONLY: single quotes would make "what's the company's policy" look like
// a quoted span ("s the company").
const QUOTED_RE = /"([^"]{1,120})"|“([^”]{1,120})”/g;

// "$1,200" and "1200" are the same fact; "40%" and "40" are not. So strip the
// currency sign and thousands separators, keep % and the scale suffix.
const normalizeNumeric = (raw: string): string =>
  raw.replace(/[$,]/g, "").toLowerCase();

// The tokens that make two questions factually distinct even when phrased
// identically. Namespaced by kind ("n:" numeric, "a:" acronym, "q:" quoted) so
// a quoted span can never collide with an acronym of the same text.
export function entityTokens(text: string): Set<string> {
  const tokens = new Set<string>();

  for (const m of text.matchAll(NUMERIC_RE)) tokens.add(`n:${normalizeNumeric(m[0])}`);

  for (const m of text.matchAll(QUOTED_RE)) {
    const inner = (m[1] ?? m[2]).trim().toLowerCase().replace(/\s+/g, " ");
    if (inner) tokens.add(`q:${inner}`);
  }

  // An ALL-CAPS question ("WHAT IS THE PTO POLICY") makes every word look like
  // an acronym, so acronyms are only extracted from text that has lowercase
  // somewhere to contrast against. The cost is a missed acronym token, which
  // can only ever block a hit — never admit one.
  if (/[a-z]/.test(text)) {
    for (const m of text.matchAll(ACRONYM_RE)) tokens.add(`a:${m[0].toLowerCase()}`);
  }

  return tokens;
}

// Does an acronym token appear in the other text at all, in ANY case? This is
// the one bit of leniency in the guard, and it exists because acronym CASING is
// not a factual difference: "what is the PTO policy" and "what is the pto
// policy" are the same question, but only the first yields an `a:pto` token
// (see entityTokens — lowercase "pto" is indistinguishable from a word). Without
// this, ordinary lowercase typing would block its own paraphrase. A genuinely
// different acronym ("PTO" vs "FMLA") is still absent from the other text, so
// the failure mode the guard exists for is untouched. Acronym tokens are
// [a-z0-9]+ after folding, so they're regex-safe to interpolate.
const mentionedIn = (token: string, text: string): boolean =>
  token.startsWith("a:") && new RegExp(`\\b${token.slice(2)}\\b`, "i").test(text);

// --- argument order (F6) -----------------------------------------------------
//
// THE BLIND SPOT THIS CLOSES. Everything above compares SETS of tokens, so a
// question whose entities are swapped around a comparison is invisible to it:
//
//   "how many times larger was Japan's population compared to China's"
//   "how many times larger was China's population compared to Japan's"
//
// Identical numerals, identical acronyms, identical quoted spans — identical
// token sets — and different answers. Cosine is blind to it too (0.9962, the
// highest-similarity false hit in the whole F1 set), so nothing else catches it.
// F3 then hit the same shape independently on a reversed ratio ("US share of
// Allied munitions" vs "share of US-made munitions used by the Allies"). Two
// independent runs, so this is a recurring failure mode rather than one bad row.
//
// WHAT IT KEYS ON: the RELATIVE ORDER of the entities the two questions share.
// Reordering is only meaningful where something directional relates them, so the
// check requires a direction marker in BOTH texts — a comparator ("compared to",
// "than", "versus", "per", "out of") or a passive agent ("by"). Without one,
// word order in a question carries no reliable relation and blocking on it would
// be pure recall cost.
//
// DIRECTION OF ERROR. Like the rest of the guard, a false trigger only ever
// COSTS A CACHE HIT — never serves a wrong answer — so the check is written to
// be decisive where it fires rather than maximally clever. Its measured cost on
// this account's labeled set is in docs/resume-metrics-f6-results.md.

// Proper nouns carry the entities these reversals turn on (Japan, China, Allied,
// the United States) and none of them are numerals, acronyms or quoted spans, so
// the order check needs its own extractor. Capitalised, ≥3 letters, optional
// possessive.
const PROPER_RE = /\b[A-Z][a-z]{2,}(?:['\u2019]s)?\b/g;

// Question openers and other sentence-initial capitals are capitalised by
// GRAMMAR, not because they name anything, and they land first in every question
// — exactly where a spurious order difference would come from.
const NOT_AN_ENTITY = new Set([
  "what", "which", "when", "where", "who", "whom", "whose", "why", "how",
  "the", "this", "that", "these", "those", "there", "their", "they",
  "does", "did", "was", "were", "are", "can", "could", "should", "would",
  "for", "and", "but", "not", "with", "from", "into", "about", "after",
  "before", "during", "please", "tell", "give", "list", "name", "explain",
  // Calendar words. They are capitalised proper nouns, but they name a TIME
  // rather than an argument of a comparison, and they move freely between
  // phrasings of the same question ("By the end of October 1916, what was X" vs
  // "What was X by the end of October 1916"). Measured, not assumed: every one
  // of the false blocks in the first F6 run was a month changing position, and
  // dropping them removed all four while costing none of the wins. A date that
  // genuinely differs is a NUMERAL, which the token half already catches.
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

// Direction markers: something that RELATES two entities asymmetrically, so that
// swapping them changes the fact being asked for. "by" is included for the
// passive agent ("munitions manufactured BY the United States"), which is the
// form F3's reversal took.
const DIRECTION_RE =
  /\b(compared to|compared with|versus|vs\.?|than|relative to|per|out of|by)\b/i;

// Shared entity mentions in order of first appearance, deduped. Deduped because
// a repeated mention is emphasis, not an extra argument — "Japan ... Japan ...
// China" relates the same two entities as "Japan ... China".
function entitySequence(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const t = raw.toLowerCase().replace(/['\u2019]s$/, "");
    if (NOT_AN_ENTITY.has(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const m of text.matchAll(PROPER_RE)) push(m[0]);
  if (/[a-z]/.test(text)) for (const m of text.matchAll(ACRONYM_RE)) push(m[0]);
  return out;
}

// False when the two texts relate the SAME entities in a DIFFERENT order under a
// direction marker. Needs at least two shared entities: with one there is no
// order to reverse.
export function entityOrderPasses(a: string, b: string): boolean {
  if (!DIRECTION_RE.test(a) || !DIRECTION_RE.test(b)) return true;
  const sa = entitySequence(a);
  const sb = entitySequence(b);
  const shared = new Set(sa.filter((t) => sb.includes(t)));
  if (shared.size < 2) return true;
  // Compared on the SHARED entities only. An entity that appears on one side
  // alone is a set difference, which is the token guard's job and not this
  // one's — and letting it shift the sequence here would fire on questions that
  // merely mention something extra.
  const oa = sa.filter((t) => shared.has(t));
  const ob = sb.filter((t) => shared.has(t));
  return oa.join("\u0000") === ob.join("\u0000");
}

// True when two questions carry the SAME entity/number tokens AND relate them in
// the same order, i.e. nothing lexical says they're about different facts. False
// on any asymmetric-difference token — the caller must then treat the match as a
// miss.
export function entityGuardPasses(a: string, b: string): boolean {
  return entityTokensMatch(a, b) && entityOrderPasses(a, b);
}

// The token half on its own. Exported so the F6 measurement can replay the guard
// as it behaved BEFORE the order check without reconstructing it from booleans —
// `passes || !orderPasses` looks like it recovers this and does not, since it
// reads true when both halves fail.
export function entityTokensMatch(a: string, b: string): boolean {
  const ta = entityTokens(a);
  const tb = entityTokens(b);
  for (const t of ta) if (!tb.has(t) && !mentionedIn(t, b)) return false;
  for (const t of tb) if (!ta.has(t) && !mentionedIn(t, a)) return false;
  return true;
}

// Deterministic fingerprint of everything that determines a cached answer. Two
// entries with the same fingerprint were produced over the same document set by
// the same answering model, so serving one for the other is safe.
//
// Null-safe: a null part is encoded distinctly from the string "null" or "" so an
// absent value and a present one can't collide.
// WHAT actually goes in the validity key, kept here (pure, DB-free) so it can be
// asserted without a database:
//
//   documents       md5 of the DOCUMENT IDS this config has ingested. Ids only —
//                   no chunk count — so the signature is comparable across configs
//                   and re-chunking doesn't invalidate through the back door.
//   cascadeEnabled  saver mode. With it ON the answer comes from
//                   cheapModelFor(llmModel) and only escalates on an efficacy
//                   failure, so two configs with an IDENTICAL llm_model answer
//                   from different models. Without this in the key, user scoping
//                   would let a saver-mode config's cheap answer be served to a
//                   strong-model config.
//
// NOT in here, on purpose: chunkSize, chunkOverlap, topK, fusionPool, the
// retrieval embedding model, the override state — route, not truth. And not
// llmModel or the cache-key model, both of which are COLUMNS on semantic_cache,
// matched in SQL rather than hashed.
export function answerFingerprint(input: {
  cascadeEnabled: boolean;
  documents: string;
}): string {
  return fingerprintFrom([
    "sc-v2", // bump by hand to invalidate every entry (e.g. on a SYSTEM_PROMPT edit)
    input.cascadeEnabled ? "cascade" : "single",
    input.documents,
  ]);
}

export function fingerprintFrom(parts: (string | number | null)[]): string {
  // "∅" marks null; every present value is prefixed with "·" so it can NEVER
  // equal the null marker — even a part whose literal value is "∅". "␟"
  // separates fields so one value's content can't bleed into the next.
  const canonical = parts
    .map((p) => (p === null ? "∅" : `·${p}`))
    .join("␟");
  return createHash("sha256").update(canonical).digest("hex");
}

// PHASE 2 CALIBRATION — pure math (no DB), see docs/semantic-caching-plan.md.
// The orchestration that feeds these (eval-bank fetch, shadow-log fetch, and
// the threshold upsert) lives in semanticCacheCalibration.ts.

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Do two chunk-id sets share any element? Walk the smaller set.
const intersects = (a: Set<string>, b: Set<string>): boolean => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
};

export type CollisionFloorResult = {
  floor: number | null; // max cosine among DISTINCT-question pairs (the safety floor)
  sameAnswerMin: number | null; // min cosine among same-ground-truth pairs
  sameAnswerMedian: number | null;
  recommended: number | null; // suggested threshold, or null when uncalibratable
  distinctPairs: number;
  sameAnswerPairs: number;
  questionsUsed: number;
  overlap: boolean; // floor ≥ sameAnswerMin → no fully-safe band exists
};

// Collision-floor calibration from the eval bank. Two labeled questions that
// share a ground-truth chunk are a "same-answer" pair (a hit between them is
// roughly OK); different chunks → a "distinct" pair (a hit would serve a wrong
// answer). The FLOOR is the highest cosine among distinct pairs — the closest
// two genuinely-different questions ever land, so any threshold must sit above
// it. `recommended` is floor + margin, capped just under the lowest same-answer
// pair when a safe band exists (maximising paraphrase coverage without a false
// hit on the eval bank). Robust half is the floor: it comes only from distinct
// pairs, so the leaky "same chunk ≠ same answer" proxy can't corrupt it.
export function collisionFloor(
  labels: { questionId: string; sourceChunkId: string }[],
  vectors: Map<string, number[]>,
  margin: number,
): CollisionFloorResult {
  // Ground-truth chunk set per question that actually has a cached vector.
  const chunkSets = new Map<string, Set<string>>();
  for (const l of labels) {
    if (!vectors.has(l.questionId)) continue;
    let s = chunkSets.get(l.questionId);
    if (!s) {
      s = new Set();
      chunkSets.set(l.questionId, s);
    }
    s.add(l.sourceChunkId);
  }

  const ids = [...chunkSets.keys()];
  let floor: number | null = null;
  const sameAnswerSims: number[] = [];
  let distinctPairs = 0;

  for (let i = 0; i < ids.length; i++) {
    const vi = vectors.get(ids[i])!;
    const ci = chunkSets.get(ids[i])!;
    for (let j = i + 1; j < ids.length; j++) {
      const sim = cosine(vi, vectors.get(ids[j])!);
      if (intersects(ci, chunkSets.get(ids[j])!)) {
        sameAnswerSims.push(sim);
      } else {
        distinctPairs++;
        if (floor === null || sim > floor) floor = sim;
      }
    }
  }

  const sameAnswerMin = sameAnswerSims.length ? Math.min(...sameAnswerSims) : null;
  const overlap = floor !== null && sameAnswerMin !== null && floor >= sameAnswerMin;

  let recommended: number | null = null;
  if (floor !== null) {
    let r = floor + margin;
    if (sameAnswerMin !== null && !overlap) r = Math.min(r, sameAnswerMin);
    recommended = Math.min(1, Math.max(0, r));
  }

  return {
    floor,
    sameAnswerMin,
    sameAnswerMedian: median(sameAnswerSims),
    recommended,
    distinctPairs,
    sameAnswerPairs: sameAnswerSims.length,
    questionsUsed: ids.length,
    overlap,
  };
}

export type CalibrationResult = {
  recommended: number | null; // lowest τ whose served set stays ≥ target
  target: number;
  minSamples: number;
  totalJudged: number;
  overallAcceptRate: number | null;
  // Accept-labeled events in the whole set — recall's DENOMINATOR. Without it
  // the sweep can say "when I serve, I'm right 99% of the time" but not "…and
  // I'm walking past 60% of the available savings to get there".
  totalAccepts: number;
  // Recall at the recommended τ: the share of ALL accept-labeled pairs that τ
  // actually serves. This is the business metric — savings captured at the
  // safety level we committed to — and the number models are ranked by, because
  // each model gets its OWN τ at the same precision target, which is what makes
  // them comparable across spaces whose cosine scales differ. null when there's
  // no recommendation (or nothing to recall).
  coverageAtRecommended: number | null;
  // Precision at that same τ — what the served set actually achieves, which is
  // ≥ target by construction. Read at the TIE BOUNDARY where τ was chosen, so it
  // describes the whole tie group `sim >= τ` would admit.
  precisionAtRecommended: number | null;
  // Acceptance rate over every event AT OR ABOVE each sim — the calibration
  // curve — plus the recall that prefix achieves. Points are ordered by
  // descending sim (n grows left→right).
  //
  // Shipped to the client in full (see LeaderboardRow.calibration): it holds
  // every candidate operating point, so the panel can re-derive τ at a target
  // the server never saw without re-running anything.
  curve: CurvePoint[];
  // WHY there's no τ, when there isn't one. A bare `recommended: null` is the
  // single most misread output of this function: it looks like "this model is
  // bad" but is usually "the target is arithmetically out of reach on a set this
  // size". Callers rank on recall@τ and fall back to AUC when every recall is
  // null (keyModelSweep), so an unexplained null quietly becomes a ranking.
  attainability: Attainability;
};

// Precision-at-threshold sweep over judged shadow events. Sort by sim desc; for
// each prefix the accept rate is P(accept | sim ≥ this sim). `recommended` is the
// LOWEST sim whose prefix still clears `target` with at least `minSamples` events
// — the most inclusive threshold whose served set keeps the false-hit rate under
// (1 − target). Non-monotonic dips are fine: the guarantee is on the aggregate
// over the served set.
//
// TWO STEPS, deliberately split: this builds the curve, selectFromCurve makes the
// choice. The panel re-derives τ at a target the server never saw, from the curve
// alone, using that same function — so a number explored on screen is
// arithmetically the number that would be applied. Anything added to the choice
// belongs THERE, not here, or the two paths drift.
export function calibrateFromJudged(
  events: { sim: number; verdict: "accept" | "reject" }[],
  target: number,
  minSamples: number,
): CalibrationResult {
  const sorted = [...events].sort((a, b) => b.sim - a.sim);
  const curve: CurvePoint[] = [];
  // Recall's denominator, needed BEFORE the sweep so each prefix can report the
  // share of all accepts it covers rather than only the count it contains.
  const totalAccepts = sorted.reduce((n, e) => n + (e.verdict === "accept" ? 1 : 0), 0);
  let accepts = 0;

  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k].verdict === "accept") accepts++;
    const n = k + 1;
    curve.push({
      sim: sorted[k].sim,
      acceptRateAtOrAbove: accepts / n,
      coverageAtOrAbove: totalAccepts === 0 ? 0 : accepts / totalAccepts,
      n,
    });
  }

  const selected = selectFromCurve(curve, target, minSamples);

  return {
    recommended: selected.recommended,
    target,
    minSamples,
    totalJudged: sorted.length,
    overallAcceptRate: sorted.length ? accepts / sorted.length : null,
    totalAccepts,
    coverageAtRecommended: selected.coverageAtRecommended,
    precisionAtRecommended: selected.precisionAtRecommended,
    curve,
    attainability: selected.attainability,
  };
}

// AUC — P(a random SAME pair outranks a random DIFFERENT pair). Computed as the
// Mann-Whitney U statistic with AVERAGE ranks for ties. Purely RANK-based, so it's
// immune to cosine-scale differences across models by construction — the reason
// it's here at all, since raw similarity magnitudes can never be compared between
// embedding spaces.
//
// SECONDARY to recall@τ, deliberately. AUC grades the WHOLE ranking, and a cache
// only ever serves from the very top of it: a model can win on AUC by ordering the
// middle well and still be worse where it counts. A sanity check and a tiebreak,
// not the objective.
//
// null when either class is missing — with no same pairs or no different pairs
// there is no ordering question to ask, and any number would be an artifact.
export function auc(
  pairs: { sim: number; label: "same" | "different" }[],
): number | null {
  const nSame = pairs.filter((p) => p.label === "same").length;
  const nDiff = pairs.length - nSame;
  if (nSame === 0 || nDiff === 0) return null;

  // Ascending by sim, then averaged ranks within each run of equal sims. Ties
  // MUST share a rank: a tie contributes half a "win", and integer ranks would
  // silently award the whole win to whichever side sorted first.
  const sorted = [...pairs].sort((a, b) => a.sim - b.sim);
  const ranks = new Array<number>(sorted.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].sim === sorted[i].sim) j++;
    // 1-based ranks i+1..j+1, averaged over the run.
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }

  let rankSumSame = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].label === "same") rankSumSame += ranks[i];
  }
  // U = R_same − n_same(n_same+1)/2; AUC = U / (n_same · n_diff).
  const u = rankSumSame - (nSame * (nSame + 1)) / 2;
  return u / (nSame * nDiff);
}
