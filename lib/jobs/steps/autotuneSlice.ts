// The slice arithmetic of an autotune run, with no database under it.
//
// This exists because the bug it fixes was only ever visible ACROSS a slice
// boundary, and every test that could have caught it needed a corpus. A run used
// to re-derive its chunk list from prepareAutotune() every slice, which reads
// failingMetrics(), which returns [] for a stale question. Keeping one override
// changes the global retrieval fingerprint, so after slice 1 every question in
// the config except the tuned chunk's own is stale — and slice 2 planned an empty
// sweep and fell through to its tail with nothing done and nothing said.
//
// The fix is to freeze the ordered chunk list at plan time and filter it per
// slice instead of rebuilding it. What is left is a decision per chunk, made from
// values a test can hand it directly.
import type { AutotuneStopReason } from "@/lib/rag/autotune";

// One chunk of the frozen plan. Ordering is prepareAutotune's deterministic
// worst-first sort, captured once; membership never changes after that.
export type PlanEntry = { chunkId: string; questionIds: string[] };

// A planned question's standing right now. `missing` covers deletion and being
// ignored — both mean the question can no longer be a reason to visit its chunk.
export type QuestionState = "missing" | "stale" | "passing" | "failing";

// What the slice should do with a chunk it has not finished with yet.
//
//   search   at least one of its questions is fresh and below its bar.
//   rescore  at least one is stale, so the honest answer is unknown: score those
//            questions and ask again. ~1.2 questions per chunk, and it is what
//            keeps a skip from being a guess.
//   skip     every question is fresh and passing (or gone). The chunk is covered
//            — a neighbouring override already fixed it — and counts as covered,
//            not as work left, so the run does not report a short sweep.
export type ChunkAction = "search" | "rescore" | "skip";

export type ChunkDecision = { chunkId: string; questionIds: string[]; action: ChunkAction };

// Decide the whole frozen plan against live question state, minus the chunks this
// run has already finished with. `covered` is every chunk it is done with for any
// reason — searched, given up on, or skipped — because with a frozen plan those
// are the same thing to the filter, and keeping one set is what makes
// chunks_searched countable without double-counting a skip on the next slice.
export function nextChunks(
  plan: PlanEntry[],
  covered: ReadonlySet<string>,
  live: ReadonlyMap<string, QuestionState>,
): ChunkDecision[] {
  const out: ChunkDecision[] = [];
  for (const entry of plan) {
    if (covered.has(entry.chunkId)) continue;
    out.push({ ...entry, action: decide(entry.questionIds, live) });
  }
  return out;
}

// Stale beats failing: a stale question's stored score was computed under a
// retrieval state that no longer exists, so "is it failing" has no answer until
// it is re-scored. Treating it as passing is the original bug; treating it as
// failing would search chunks that are already fine.
function decide(questionIds: string[], live: ReadonlyMap<string, QuestionState>): ChunkAction {
  let failing = false;
  for (const id of questionIds) {
    const state = live.get(id) ?? "missing";
    if (state === "stale") return "rescore";
    if (state === "failing") failing = true;
  }
  return failing ? "search" : "skip";
}

// --- draining a set that re-screens itself ----------------------------------

// Both `settle` and the dirty-set re-score work the same way: screen the corpus,
// score what came back, screen again, and stop when nothing does. Neither keeps a
// cursor, because a question scored under the final state drops out of the next
// screen by itself. That self-elimination is also the hazard — a question that can
// never come back clean would re-score forever — so each carries the size of its
// last COMPLETE pass and gives up when a pass fails to shrink the set.
//
// "Complete" is the whole subtlety, and it is why this is a function rather than
// an inline comparison. A slice that YIELDED part way through its set (§D.2) has a
// smaller index for a reason that says nothing about whether the work is making
// progress, and recording it as a pass would trip the guard on a run that is
// working perfectly. Only a slice that reached the end of the set gets to speak.
export function passSize(scored: number, setSize: number, last: number | null): number | null {
  return scored >= setSize ? setSize : last;
}

// Has a set that re-screens itself stopped shrinking? Never true before a
// complete pass has been recorded — there is nothing to compare against, and a
// first slice that yields early must not read as no-progress.
// `== null` rather than `!== null`: a cursor persisted before this field existed
// deserializes it as undefined, and reading that as "a pass of size undefined"
// would make the comparison NaN-ish rather than simply absent.
export function drainStuck(setSize: number, last: number | null | undefined): boolean {
  return last != null && setSize >= last;
}

// --- coverage ---------------------------------------------------------------

// Was there work left on the table, and should the UI offer to pick it up?
//
// Derived from the counts rather than from a list of stop reasons. The allowlist
// this replaces (`budget || cancelled`) is how a truncated run stayed quiet: a
// new way to stop short falls off a list silently, and cannot fall off a
// subtraction. Early-stop is the one short run that is a success — it stopped
// because the aggregate bars were met (0024) — so it keeps its own message.
export function leftWork(args: {
  chunksSearched: number;
  chunksTotal: number;
  stopReason: AutotuneStopReason | null;
}): boolean {
  if (args.stopReason === "early") return false;
  return args.chunksSearched < args.chunksTotal;
}
