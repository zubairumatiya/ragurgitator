// The pure half of the autotune HOLDOUT (Phase 2b of docs/resume-metrics-plan.md):
// given the config's labeled questions and its holdout settings, decide which
// question ids form the test set. No DB, no server-only import, so the decisions
// that make the generalization number defensible are testable on their own.
//
// Two properties do the work:
//
// SEEDED. The draw is a function of (ids, difficulties, size, seed) alone, so the
// split can be re-derived months later from four numbers stored on the config.
// An unseeded split makes the number unverifiable, which is the same as unusable.
//
// STRATIFIED BY DIFFICULTY. A flat random 25% can take mostly `easy` questions,
// leaving the holdout systematically easier than the train set and quietly
// inflating the generalization delta. Sampling within each difficulty band means
// the two sets are comparable by construction, so the train→holdout gap reads as
// overfitting rather than as an artefact of the draw.

export type HoldoutMode = "pct" | "count";

export type HoldoutSettings = {
  enabled: boolean;
  mode: HoldoutMode;
  // Percent (0–100) when mode is 'pct'; an absolute question count otherwise.
  size: number;
  seed: number;
};

export type HoldoutCandidate = {
  questionId: string;
  difficulty: string | null;
};

// How many questions the settings ask for, clamped to what exists. Percent
// rounds to nearest, so 25% of 390 is 98 rather than a silently truncated 97.
export function holdoutTarget(total: number, settings: HoldoutSettings): number {
  if (!settings.enabled || total <= 0) return 0;
  const raw =
    settings.mode === "pct"
      ? Math.round((total * settings.size) / 100)
      : Math.floor(settings.size);
  return Math.max(0, Math.min(total, raw));
}

// mulberry32 — a small, fast PRNG with a 32-bit state. Chosen because it is
// short enough to read and reimplement: reproducing a published split must not
// depend on a dependency's version-to-version RNG behaviour.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates over a COPY, always from ids sorted ascending first: the caller's
// row order comes from the database and is not guaranteed stable, so shuffling
// it directly would make the seed insufficient to reproduce the draw.
function shuffled(ids: string[], seed: number): string[] {
  const out = [...ids].sort();
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Largest-remainder apportionment of `target` across the bands, so the quotas
// sum to exactly `target` and each band's share tracks its size. Ties break on
// the band name, keeping the whole thing deterministic.
function quotas(bands: Map<string, string[]>, total: number, target: number): Map<string, number> {
  const out = new Map<string, number>();
  const remainders: { band: string; frac: number }[] = [];
  let assigned = 0;
  for (const [band, ids] of bands) {
    const exact = (ids.length * target) / total;
    const floor = Math.min(ids.length, Math.floor(exact));
    out.set(band, floor);
    assigned += floor;
    remainders.push({ band, frac: exact - floor });
  }
  remainders.sort((a, b) => b.frac - a.frac || a.band.localeCompare(b.band));
  // Sweep in remainder order until the target is met. Repeats because a band
  // can hit its own size cap (a tiny `hard` band under a large percentage), and
  // the questions it can't take have to land somewhere.
  while (assigned < target) {
    let progressed = false;
    for (const { band } of remainders) {
      if (assigned >= target) break;
      const cur = out.get(band)!;
      if (cur < bands.get(band)!.length) {
        out.set(band, cur + 1);
        assigned += 1;
        progressed = true;
      }
    }
    if (!progressed) break; // every band is full: target exceeded the pool
  }
  return out;
}

// The test set: `target` question ids, stratified by difficulty.
//
// `alreadyHeld` makes the draw STABLE under a growing question set. Questions
// are written in batches (Phase 5), and a fresh seeded shuffle over a larger
// pool would reassign existing questions between train and holdout — which,
// after a tuning pass, silently leaks train questions into the test set. Keeping
// current members and topping up from the rest cannot do that.
export function selectHoldout(
  candidates: HoldoutCandidate[],
  target: number,
  seed: number,
  alreadyHeld: ReadonlySet<string> = new Set(),
): string[] {
  if (target <= 0 || candidates.length === 0) return [];

  const bands = new Map<string, string[]>();
  for (const c of candidates) {
    const band = c.difficulty ?? "";
    const ids = bands.get(band);
    if (ids) ids.push(c.questionId);
    else bands.set(band, [c.questionId]);
  }
  // Iterate bands in name order so the quota pass sees the same sequence
  // regardless of the row order the candidates arrived in.
  const ordered = new Map([...bands].sort((a, b) => a[0].localeCompare(b[0])));
  const per = quotas(ordered, candidates.length, Math.min(target, candidates.length));

  const picked: string[] = [];
  for (const [band, ids] of ordered) {
    // Band-specific seed: otherwise every band walks the same random sequence,
    // and ids at the same sorted position get correlated draws across bands.
    const order = shuffled(ids, (seed + band.length * 7919) >>> 0);
    // Current members first, then the shuffle order — so a top-up adds without
    // reshuffling, and an over-target set drops its most recent picks.
    order.sort(
      (a, b) => Number(alreadyHeld.has(b)) - Number(alreadyHeld.has(a)),
    );
    picked.push(...order.slice(0, per.get(band) ?? 0));
  }
  return picked;
}
