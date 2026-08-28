// THE COLLISION FLOOR, OVER THREE POPULATIONS.
//
// A floor is one piece of arithmetic — the MAX cosine among pairs that are KNOWN
// TO BE DIFFERENT — asked of three different sets of labels. The number means the
// same thing in each: two questions this account holds that want different
// answers land this close, so a threshold at or below it is known to serve at
// least one wrong answer.
//
// What differs is WHERE THE LABELS COME FROM, and that decides which floor may be
// applied:
//
//   eval     Ground-truth chunk ids from the eval bank. OBJECTIVE — nothing was
//            asked to judge anything — and the only population whose floor may be
//            applied to a serving threshold. Lives in semanticCacheCalibration
//            (computeCollisionFloor), because it is also the one that is saved and
//            that emits a recommendation.
//   pairs    LLM-written hard negatives (0040). Engineered to sit as close as the
//            generator could manage, and the F3 audit put them at ~80% correct, so
//            this is a WORST-CASE BOUND to read, never a number to apply.
//   traffic  Real would-hit events a judge REJECTED. The most honest labels on the
//            page and usually the emptiest set — this account has 0 rejects across
//            91 judged, so it reads empty and fills in as the cache is used.
//
// NEVER EMBEDS. The pair-bank floor reads `cachedQueryVectors`, the cache-only
// path, for the same reason `getCachedQueryEmbeddings` backs the eval floor: a
// key model this account has never swept under must yield an honest empty, not a
// surprise embedding bill from opening a panel. `missingVectors` reports what that
// cost, so an empty floor is legible rather than mysterious.
import { activeConfig } from "@/lib/rag/activeConfig";
import { getBatchSavings } from "@/lib/rag/batchStore";
import { sql } from "@/lib/db";
import { cachedQueryVectors } from "@/lib/rag/embedCache";
import { resolveKeyModel } from "@/lib/rag/semanticCache";
import { ownedConfigs } from "@/lib/rag/semanticCacheCalibration";
import { listPairs } from "@/lib/rag/semanticCachePairs";
import {
  cosine,
  pushTopPair,
  spaceOf,
  FLOOR_PAIRS_SHOWN,
  type FloorPair,
} from "@/lib/rag/semanticCacheCore";

// The three label sources, and the identifier the UI and the route agree on.
export type FloorPopulation = "eval" | "pairs" | "traffic";

// Only ONE of them may move a serving threshold. Stated as data rather than left
// to each caller's memory, because the applicability rule here INVERTS the one on
// the would-hit queue (where traffic is applicable and probes are the bound) —
// two similar-looking selectors whose trust rules run opposite ways is exactly
// how the wrong number gets applied.
export const FLOOR_APPLICABLE: Record<FloorPopulation, boolean> = {
  eval: true,
  pairs: false,
  traffic: false,
};

export const isFloorPopulation = (v: unknown): v is FloorPopulation =>
  v === "eval" || v === "pairs" || v === "traffic";

// What the two BOUND populations report. Deliberately not the eval report's shape:
// they have no ground-truth same-answer side, so there is no safe band, no
// recommendation and nothing to save — and a shape that pretended otherwise would
// invite the UI to draw one.
export type BoundFloorReport = {
  population: "pairs" | "traffic";
  space: string;
  embeddingModel: string;
  // Max cosine among the known-different pairs, or null when the population is
  // empty. Null is a real answer here, not a failure.
  floor: number | null;
  // How many known-different pairs the floor was taken over.
  comparisons: number;
  // Pairs dropped for want of a banked vector (pairs population only; the traffic
  // floor reads similarities the serving path already computed, so it drops
  // nothing). The floor is a MAX, so a dropped pair can only ever have made it
  // higher — this number is how far the bound might be understated.
  missingVectors: number;
  // The pairs nearest the floor, highest first. Same contract as the eval
  // report's topDistinct: a MAX rests on one pair, so its cause travels with it.
  top: FloorPair[];
  computedAt: string; // ISO — nothing here is saved, so this is always "just now"
};

// The vector-space every floor on this page is quoted in: the space the CACHE
// matches in for the active config, not its retrieval space. Same resolution
// computeCollisionFloor does, so the three populations are directly comparable and
// all three are checked against the same live threshold row.
async function keyModelForActiveConfig(): Promise<string> {
  const savings = await getBatchSavings(activeConfig().id);
  return resolveKeyModel(savings.semanticCache.keyModel);
}

export async function computeBoundFloor(
  population: "pairs" | "traffic",
): Promise<BoundFloorReport> {
  const model = await keyModelForActiveConfig();
  const base = {
    population,
    space: spaceOf(model),
    embeddingModel: model,
    computedAt: new Date().toISOString(),
  };
  return population === "pairs"
    ? { ...base, ...(await pairBankFloor(model)) }
    : { ...base, ...(await trafficFloor(spaceOf(model))) };
}

// --- pair bank ---------------------------------------------------------------

// listPairs already EXCLUDES quarantined rows (F3): a pair whose audit verdict
// contradicts its constructed label is a mislabel, and a mislabeled "hard
// negative" that is really a paraphrase would set this floor single-handedly at
// the exact cosine where paraphrases live. Excluding it is the difference between
// a bound and a bogus one, and it is why the quarantine exists.
async function pairBankFloor(
  model: string,
): Promise<Pick<BoundFloorReport, "floor" | "comparisons" | "missingVectors" | "top">> {
  const different = (await listPairs()).filter((p) => p.label === "different");
  const texts = [...new Set(different.flatMap((p) => [p.textA, p.textB]))];
  const vectors = await cachedQueryVectors(texts, model);

  let floor: number | null = null;
  let comparisons = 0;
  let missingVectors = 0;
  const top: FloorPair[] = [];
  for (const p of different) {
    const va = vectors.get(p.textA);
    const vb = vectors.get(p.textB);
    if (!va || !vb) {
      missingVectors++;
      continue;
    }
    const sim = cosine(va, vb);
    comparisons++;
    if (floor === null || sim > floor) floor = sim;
    pushTopPair(top, { a: p.textA, b: p.textB, sim });
  }
  return { floor, comparisons, missingVectors, top };
}

// --- real traffic ------------------------------------------------------------

// REJECTED events only, and `origin = 'traffic'` only. A reject is the one shadow
// verdict that means "these two questions are different" — the same claim the eval
// bank's chunk ids make — so the arithmetic is unchanged. Probe rows are excluded
// because they are the pair bank pushed through the shadow path (0069); counting
// them here would report the pair-bank bound under the name "real traffic".
//
// The similarity is the one the serving path already computed and stored, so this
// population reads no vectors at all.
async function trafficFloor(
  space: string,
): Promise<Pick<BoundFloorReport, "floor" | "comparisons" | "missingVectors" | "top">> {
  let rows: { new_query: string; matched_query: string; sim: number; total: number }[];
  try {
    rows = await sql<{ new_query: string; matched_query: string; sim: number; total: number }[]>`
      select new_query, matched_query, sim,
             count(*) over ()::int as total
      from semantic_cache_shadow
      where space = ${space} and ${ownedConfigs()}
        and verdict = 'reject' and origin = 'traffic'
      order by sim desc
      limit ${FLOOR_PAIRS_SHOWN}`;
  } catch (err) {
    // Pre-migration (42P01) reads as an empty population, like every other shadow
    // read in this subsystem.
    if ((err as { code?: string }).code !== "42P01") throw err;
    rows = [];
  }
  return {
    floor: rows.length ? Number(rows[0].sim) : null,
    // The window count, so `comparisons` is the whole rejected set and not the
    // five rows the LIMIT returned.
    comparisons: rows[0]?.total ?? 0,
    missingVectors: 0,
    top: rows.map((r) => ({ a: r.new_query, b: r.matched_query, sim: Number(r.sim) })),
  };
}
