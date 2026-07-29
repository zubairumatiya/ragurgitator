// ---------------------------------------------------------------------------
// SEMANTIC CACHE — pure core (no DB, no I/O), so it's unit-testable without a
// database connection (mirrors how evalMetrics.ts is split out of eval.ts —
// the test imports THIS file, not the DB-touching orchestration).
//
// The cache serves a PAST answer for a NEW question when the two are close
// enough in embedding space — see docs/semantic-caching-plan.md. This file owns
// the three decisions that make a hit correct:
//   - spaceOf()             which threshold applies (per embedding vector-space)
//   - bestMatch() / isHit() is the nearest cached query close enough to serve?
//   - fingerprintFrom()     is a cached entry still valid for today's config?
// Everything here is deterministic and dependency-light on purpose.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

// RELATIVE import on purpose: EMBEDDING_MODELS is a VALUE import, and the test
// runner (node --import tsx) doesn't resolve the "@/" path alias for runtime
// values — only Next's bundler does. embeddingModels.ts is itself dependency-
// free, so this stays importable without a DATABASE_URL.
import { EMBEDDING_MODELS } from "./embeddingModels";

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

// ---------------------------------------------------------------------------
// ENTITY / NUMBER GUARD — see docs/semantic-cache-key-model-plan.md, Phase 0.
//
// Embeddings fail hardest on the tokens that make two identically-phrased
// questions FACTUALLY different: "what was 2023 revenue" vs "what was 2024
// revenue" sits near 0.98 cosine under essentially every model, so no threshold
// that still serves paraphrases can separate them. It's a lexical failure, so
// it gets a lexical fix rather than a better model.
//
// The guard is CONSERVATIVE BY CONSTRUCTION: it can only ever turn a would-be
// hit into a miss, never the reverse. Its worst case is lost savings — which is
// exactly why a blocked match is still shadow-logged (guard_blocked, migration
// 0038), so the recall it costs is measurable instead of arguable.
//
// Deliberately NO NER model: a dependency and per-lookup latency for a guard
// whose whole job is catching a failure mode that regex token sets already
// catch.
// ---------------------------------------------------------------------------

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

// True when two questions carry the SAME entity/number tokens, i.e. nothing
// lexical says they're about different facts. False on any asymmetric-difference
// token — the caller must then treat the match as a miss.
export function entityGuardPasses(a: string, b: string): boolean {
  const ta = entityTokens(a);
  const tb = entityTokens(b);
  for (const t of ta) if (!tb.has(t) && !mentionedIn(t, b)) return false;
  for (const t of tb) if (!ta.has(t) && !mentionedIn(t, a)) return false;
  return true;
}

// Deterministic fingerprint of everything that determines a cached answer. Two
// entries with the same fingerprint were produced by the same config shape
// (embedding model, chunking, top-k, fusion pool, LLM) over the same corpus and
// override state, so serving one for the other is safe. Any change flips the
// fingerprint; stale entries then stop matching (and get GC'd on the next
// store). Null-safe: a null part (e.g. auto fusion pool) is encoded distinctly
// from the string "null" or "" so "auto" and an actual value can't collide.
export function fingerprintFrom(parts: (string | number | null)[]): string {
  // "∅" marks null; every present value is prefixed with "·" so it can NEVER
  // equal the null marker — even a part whose literal value is "∅". "␟"
  // separates fields so one value's content can't bleed into the next.
  const canonical = parts
    .map((p) => (p === null ? "∅" : `·${p}`))
    .join("␟");
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// PHASE 2 CALIBRATION — pure math (no DB), see docs/semantic-caching-plan.md.
// The orchestration that feeds these (eval-bank fetch, shadow-log fetch, and
// the threshold upsert) lives in semanticCacheCalibration.ts.
// ---------------------------------------------------------------------------

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
  // Acceptance rate over every event AT OR ABOVE each sim — the calibration
  // curve — plus the recall that prefix achieves. Points are ordered by
  // descending sim (n grows left→right).
  curve: { sim: number; acceptRateAtOrAbove: number; coverageAtOrAbove: number; n: number }[];
  // WHY there's no τ, when there isn't one. A bare `recommended: null` is the
  // single most misread output of this function: it looks like "this model is
  // bad" but is usually "the target is arithmetically out of reach on a set this
  // size". Callers rank on recall@τ and fall back to AUC when every recall is
  // null (keyModelSweep), so an unexplained null quietly becomes a ranking.
  attainability: Attainability;
};

// The blocker, most-fundamental first:
//   no-events           nothing judged at all — go label something.
//   below-min-samples   judged, but never `minSamples` events in one prefix, so
//                       no prefix was ever ELIGIBLE to be recommended.
//   target-unreachable  eligible prefixes existed and none cleared `target`.
//                       This is the interesting one: `bestRate` is how close the
//                       best of them got, and `requiredN` is how large a prefix
//                       that target would have needed given its reject count.
//   null                a τ was recommended; nothing to explain.
export type AttainabilityBlocker =
  | "no-events"
  | "below-min-samples"
  | "target-unreachable"
  | null;

export type Attainability = {
  blocker: AttainabilityBlocker;
  // Best acceptance rate over ELIGIBLE prefixes (n ≥ minSamples, at a tie
  // boundary) and where it occurred. null when no prefix was eligible.
  bestRate: number | null;
  bestRateAt: { sim: number; n: number } | null;
  // Rejects inside that best prefix — the reason the target wasn't met.
  rejectsInBest: number;
  // The prefix size at which `target` becomes arithmetically POSSIBLE while
  // still carrying `rejectsInBest` rejects: rate ≥ target ⟺ n ≥ r / (1 − target).
  // This is the "you need n ≥ 100, you have 34" number. null when it can't be
  // stated: no eligible prefix, target ≥ 1 (no reject count is ever forgivable),
  // or the best prefix is already clean (r = 0, so the target was met).
  requiredN: number | null;
};

// Precision-at-threshold sweep over judged shadow events. Sort by sim desc; for
// each prefix (the top-n by similarity) the accept rate is P(accept | sim ≥
// this sim). `recommended` is the LOWEST sim whose prefix still clears `target`
// with at least `minSamples` events — i.e. the most inclusive threshold whose
// served set keeps the false-hit rate under (1 − target). Non-monotonic dips
// are handled naturally: the guarantee is on the aggregate over the served set,
// so a dip that later recovers is allowed.
export function calibrateFromJudged(
  events: { sim: number; verdict: "accept" | "reject" }[],
  target: number,
  minSamples: number,
): CalibrationResult {
  const sorted = [...events].sort((a, b) => b.sim - a.sim);
  const curve: CalibrationResult["curve"] = [];
  // Recall's denominator, needed BEFORE the sweep so each prefix can report the
  // share of all accepts it covers rather than only the count it contains.
  const totalAccepts = sorted.reduce((n, e) => n + (e.verdict === "accept" ? 1 : 0), 0);
  let accepts = 0;
  let recommended: number | null = null;
  let coverageAtRecommended: number | null = null;
  // Best ELIGIBLE prefix seen, for the attainability report. Eligibility is the
  // same predicate `recommended` uses (tie boundary + n ≥ minSamples), so the
  // explanation can never describe a prefix the sweep would not have considered.
  let bestRate: number | null = null;
  let bestRateAt: { sim: number; n: number } | null = null;
  let rejectsInBest = 0;

  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k].verdict === "accept") accepts++;
    const n = k + 1;
    const rate = accepts / n;
    const coverage = totalAccepts === 0 ? 0 : accepts / totalAccepts;
    curve.push({ sim: sorted[k].sim, acceptRateAtOrAbove: rate, coverageAtOrAbove: coverage, n });
    // Only consider τ at the END of a run of equal sims. Mid-run, the prefix
    // covers only PART of the tie group, but serving `sim >= τ` would admit the
    // whole group — so a rate measured there doesn't hold for what we'd serve.
    // Real cosines rarely tie exactly, so this is a correctness guarantee rather
    // than a behavior change on live data.
    const isTieBoundary = k === sorted.length - 1 || sorted[k + 1].sim !== sorted[k].sim;
    if (isTieBoundary && n >= minSamples && (bestRate === null || rate > bestRate)) {
      bestRate = rate;
      bestRateAt = { sim: sorted[k].sim, n };
      rejectsInBest = n - accepts;
    }
    if (isTieBoundary && rate >= target && n >= minSamples) {
      recommended = sorted[k].sim;
      // Moves WITH `recommended`: τ walks downward to the most inclusive value
      // that still clears the target, and the recall reported must be the one
      // that τ achieves, not the tighter prefix's.
      coverageAtRecommended = totalAccepts === 0 ? null : coverage;
    }
  }

  // requiredN inverts the acceptance test: accepts/n ≥ target with r rejects
  // means (n − r)/n ≥ target, i.e. n ≥ r / (1 − target). At target = 1 the
  // denominator is 0 — no prefix size ever forgives a single reject — so the
  // honest answer is "not statable" rather than Infinity. Only meaningful when
  // the best prefix actually FAILED, which is why it's gated on the blocker.
  const requiredN =
    bestRateAt !== null && rejectsInBest > 0 && target < 1
      ? Math.ceil(rejectsInBest / (1 - target))
      : null;

  const blocker: AttainabilityBlocker =
    recommended !== null
      ? null
      : sorted.length === 0
        ? "no-events"
        : bestRateAt === null
          ? "below-min-samples"
          : "target-unreachable";

  return {
    recommended,
    target,
    minSamples,
    totalJudged: sorted.length,
    overallAcceptRate: sorted.length ? accepts / sorted.length : null,
    totalAccepts,
    coverageAtRecommended,
    curve,
    attainability: { blocker, bestRate, bestRateAt, rejectsInBest, requiredN },
  };
}

// AUC — P(a random SAME pair outranks a random DIFFERENT pair). 0.5 is a coin
// flip, 1.0 is perfect separation. Computed as the Mann-Whitney U statistic with
// AVERAGE ranks for ties, which is exactly equivalent and needs no thresholding.
//
// Purely RANK-based, so it's immune to cosine-scale differences across models by
// construction — the reason it's here at all, since raw similarity magnitudes
// can never be compared between embedding spaces.
//
// SECONDARY to recall@τ, deliberately. AUC grades the WHOLE ranking, and a cache
// only ever serves from the very top of it: a model can win on AUC by ordering
// the middle of the distribution well and still be worse where it counts. Use it
// as a sanity check and a tiebreak, not as the objective.
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
