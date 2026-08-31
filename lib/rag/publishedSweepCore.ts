// THE PUBLISHED SWEEP'S WIRE FORM — phase 1.5 of docs/demo-cache-lab-plan.md.
//
// Dependency-free at runtime, like semanticCacheCore.ts and keyModelSweepCore.ts,
// because BOTH ends need it: publishedSweep.ts packs on the way into 0077, and
// KeyModelPanel — a Client Component — unpacks on the way out. Keeping one
// module means the two cannot drift into a form only one of them writes.
//
// The type import below is erased at compile time, so naming SweepResult here
// costs the client bundle nothing; the panel already type-imports it.
//
// WHAT THIS BUYS, and against which meter. Phase 1's thinning answered the
// page-load question (318 KB → 50 KB). This answers a different one: nothing
// writes `published_sweep` in a request path, so every panel mount RE-READS the
// whole row over the Postgres → app-server hop that Supabase bills uncompressed.
// Packing takes that read to 18 KB, and readPublishedSweep's memo removes the
// repeats. Do both, in that order: the memo kills the repeat reads, this shrinks
// the one cold read per process that survives it.
//
// It is also the safety margin. Thinning is bounded by the slider (~103 points a
// model), so eleven models could in the worst case reach ~1,130 points ≈ 140 KB
// against a 150 KB cap — a cap a larger pair set walks straight into. Packed,
// that worst case is ~50 KB.
import {
  packCurve,
  unpackCurve,
  type PackedCurvePoint,
} from "@/lib/rag/calibrationCurve";
import type { SweepResult } from "@/lib/rag/keyModelSweep";

// A SweepResult with every curve packed. Structurally identical otherwise —
// `rows`, `pairs`, `attainability` and the leaderboard's own numbers are read as
// they are, and only the curve, which is ~all of the bytes, changes shape.
export type PublishedSweep = Omit<SweepResult, "rows"> & {
  rows: (Omit<SweepResult["rows"][number], "calibration"> & {
    calibration:
      | (Omit<NonNullable<SweepResult["rows"][number]["calibration"]>, "curve"> & {
          curve: PackedCurvePoint[];
        })
      | null;
  })[];
};

const mapCurves = <In, Out>(
  rows: { calibration: ({ curve: In[] } & object) | null }[],
  f: (curve: In[]) => Out[],
) =>
  rows.map((row) =>
    row.calibration === null
      ? row
      : { ...row, calibration: { ...row.calibration, curve: f(row.calibration.curve) } },
  );

// Pack — publish time, after thinning. thinSweep first, then this: thinning
// chooses WHICH points survive by running selectFromCurve over them, which needs
// the unpacked form.
export const packSweep = (result: SweepResult): PublishedSweep =>
  ({ ...result, rows: mapCurves(result.rows, packCurve) }) as PublishedSweep;

// Unpack — in the panel, before anything reads a curve. Every field
// selectFromCurve touches is restored bit-for-bit; see calibrationCurve.test.ts,
// which asserts the round trip at all 101 slider positions.
export const unpackSweep = (published: PublishedSweep): SweepResult =>
  ({ ...published, rows: mapCurves(published.rows, unpackCurve) }) as SweepResult;
