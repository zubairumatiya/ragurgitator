// WHAT A GUEST MAY NOT DO — the spend and egress gate, in one table.
//
// Without this, /api/demo/start is a public, unauthenticated endpoint that
// spends a real Voyage key and fills a 500 MB disk. "We'll gate it next phase"
// is not a spend limit, so this ships with Phase 1 rather than with the rest of
// the caps.
//
// TWO KINDS OF ENTRY LIVE HERE, and it is worth being clear which is which:
//
//   COST      ingest, reconfigure, autotune, the sweeps, batch — work that buys
//             embeddings or LLM tokens with the operator's key, in quantities a
//             demo has no reason to spend.
//   EGRESS    the three sites that still ship VECTORS to the app server:
//             clusterStore's `select c.id, c.embedding::text` (~5.6 MB a run),
//             chunkEmbeddings() behind the override efficacy screen, and
//             /appraise → Models' replay from cached vectors (92 MB, measured
//             2026-08-25). These are cheap in dollars and ruinous in bytes,
//             which is why the gate covers more than the obviously expensive
//             levers. The third one is not in this table at all: it is a PAGE
//             RENDER, so phase 6.3 publishes its RESULT instead of gating it.
//
// WHAT IS NO LONGER IN THIS TABLE, AND WHY THAT IS NOT AN OVERSIGHT. Re-scoring
// and autotune used to sit here. Both objections to them were about SIZE — 472
// questions of retrieved chunk text, 472 questions' worth of chunks to search —
// and neither was about the lever. So phase 4 of docs/demo-analytics-plan.md
// stopped blocking them and SCOPED them instead: a published build freezes every
// question but twelve (lib/demo/frozen), and the store's scoring queries skip
// frozen rows. A blanket block and a scope are both spend limits; the difference
// is that one of them leaves the workbench working.
//
// The rule that survives: a lever whose cost is UNBOUNDED by anything the
// publish controls belongs in this table. A lever the frozen set already bounds
// does not, and adding it back would just be a second limit disagreeing with the
// first.
//
// Live retrieval is deliberately NOT in this table. It ranks in SQL and returns
// chunk text (vectorStore.ts:277/:319), and the cache probe returns one row with
// no vector — so a guest asking questions all afternoon costs ~25 KB each. That
// is the demo, and it is not what any of this is protecting.
//
// HOW IT IS ENFORCED. A blocked action throws DemoBlockedError, which
// catchingMissingKey (lib/http/configScope.ts) turns into a 403 with a
// human-readable reason — one catch site, so a plain JSON route and an NDJSON
// route cannot disagree about what happened. scripts/guards.ts sweep 5 asserts
// that every route named in DEMO_BLOCKED_ROUTES actually calls the gate.
import "server-only";

import { isGuest } from "@/lib/demo/guest";

export const DEMO_BLOCKED = "demo_blocked";

// The actions a guest cannot take, each with the sentence the visitor reads.
// Phrased as "what this would do and why the demo won't", never as an error:
// hitting one of these is the expected outcome of exploring, not a mistake.
//
// A SENTENCE MAY ONLY POINT AT SOMETHING THE CLONE CARRIES. Phase 5 of
// docs/demo-analytics-plan.md is here because several of these consoled the
// visitor with a pointer — "the saved trials show you", "its results are on the
// Appraise tab", "the override panel still shows you what a real one did" — at
// tables lib/demo/clone.ts deliberately does not copy. A refusal that sends
// someone to an empty tab is worse than a bare refusal: it spends their trust to
// say nothing. So when one of these offers a consolation, check the clone's
// "WHAT IS DELIBERATELY NOT CLONED" list first, and point at the Eval tab, live
// retrieval or the answer cache — the three things a guest actually has.
//
// `appraise` is read ONCE, as the Models tab's own empty state
// (app/appraise/models/page.tsx) — no route throws it, because the replay is a
// page render rather than an action. Since phase 6.3 that empty state is the
// FALLBACK: a build published with a warm replay carries its rows (clone step
// 5c) and the tab renders the real comparison under PUBLISHED_REPLAY_NOTE
// below. This sentence is what a build published without one says, so it still
// has to work standing alone on a blank panel.
//
// `judge` IS THE SECOND SENTENCE THAT POINTS AT A BUTTON (phase 6.2), and it is
// true for the same kind of reason `generate` is: lib/demo/clone step 5b copies a
// sample of semantic_cache_shadow, SHADOW_QUEUE_CAP of those rows with the verdict
// cleared, so the queue it names is stocked. Only the LLM half of that route is
// gated — a human verdict is one UPDATE and buys nothing from a provider — which
// is why this sentence talks about the judge MODEL rather than about judging.
//
// `generate` NOW POINTS AT A BUTTON, which is only honest because phase 6 made
// it true: lib/demo/clone step 4e copies question_cache, so "Bulk actions → Add
// question → Add cached" is a working, model-free way for a guest to add a
// question. That path is carved out of this gate in the route itself
// (app/api/eval/bulk-generate), because `cachedOnly` is the one form of that
// request that calls nothing.
//
// `sweep` IS NOW A FALLBACK TOO, for exactly `appraise`'s reason (phase 2 of
// docs/demo-cache-lab-plan.md). Clone step 5d copies the published_sweep row
// (0077), so a guest's Appraise → Semantic caching §4 renders the real
// leaderboard under PUBLISHED_SWEEP_NOTE below, and pressing "Run sweep" replays
// that row instead of buying ~510 texts × every candidate model of embeddings on
// keys the demo does not hold. This sentence is what a build published WITHOUT a
// sweep row says, so like `appraise` it still has to work standing alone on a
// blank panel — which is why it consoles with the live answer cache, the one
// thing that is true either way.
//
// `keyModel` IS NEW, and it exists because `sweep` stopped covering the whole
// route. POST /api/semantic-cache/key-model has three actions and one gate used
// to blanket all of them; phase 2 splits them, because only `sweep` has a
// published answer to hand back. `apply` and `backfill` both WRITE — one moves
// which vector-space every incoming question is matched in, the other re-embeds
// this config's banked questions under the new model — so they stay blocked,
// and they need their own sentence: telling a visitor who pressed Apply that
// "its results weren't published" would be answering a question they did not
// ask.
//
// `pairs` IS THE FOURTH SENTENCE THAT POINTS AT A BUTTON, on the same terms as
// `generate` and for the same structural reason: phase 3 of
// docs/demo-cache-lab-plan.md clones semantic_cache_pairs, so "Generate pairs"
// can hand a guest pairs that were generated and audited on the operator's
// account rather than writing new ones with an answer-model key the demo does
// not carry. The reveal is real; the writing is not. That carve-out lives in
// app/api/semantic-cache/pairs, exactly as `cachedOnly` lives in
// bulk-generate — and this sentence, again, is the fallback for a build
// published without a bank of them.
export const DEMO_ACTIONS = {
  ingest:
    "Uploading and ingesting documents is off in the demo — it would spend the " +
    "shared embedding key. The corpus you're looking at is already ingested; " +
    "sign up with your own keys to bring your own documents.",
  reconfigure:
    "Re-chunking or switching embedding model re-embeds the whole corpus, which " +
    "the demo doesn't pay for. Everything else on this page is live.",
  generate:
    "Writing a NEW question needs an answer-model key, which the demo doesn't " +
    "carry — the bank you're looking at was generated the same way. \u201cAdd " +
    "cached\u201d does work: this workspace was published with the wording " +
    "already paid for, so it hands chunks questions that cost nothing and scores " +
    "them like any other.",
  tryModel:
    "Trying a chunk under a different embedding model re-embeds it and every " +
    "chunk it is ranked against, so it's off in the demo. The question it " +
    "answers is on Appraise → Models: every model ranked over this whole " +
    "corpus, on these questions, published with the workspace — a fairer " +
    "comparison than one chunk anyway.",
  unfreeze:
    "That question is part of this demo's published measurement, not one of its " +
    "dials — un-ignoring it would let one visitor move a number the next one " +
    "reads. The questions marked tunable on the Eval tab are yours to change.",
  override:
    "Setting an override by hand re-embeds the chunk under whatever you pick, " +
    "which the demo doesn't pay for. Autotune can still write one for you: it " +
    "searches sizes on the tunable questions' own chunks, and the corpus you " +
    "were handed is deliberately untuned so there is something to find.",
  cluster:
    "Clustering downloads every chunk vector to fit centroids, so it's off in " +
    "the demo. Sign up with your own keys to run it on your corpus.",
  rank:
    "Rebuilding a question's ideal ranking embeds a pool of chunks under every " +
    "model on the list, so it's off in the demo. The graded rankings you can " +
    "open are real, and the nDCG on the Eval tab is scored against them.",
  appraise:
    "The model comparison replays the whole corpus from cached vectors — 92 MB " +
    "of them — which the demo doesn't have the bandwidth to do per visitor, so " +
    "it ships the result instead of re-running it. This build was published " +
    "without one. The Eval tab is where this demo measures itself: published " +
    "scores for every question, and a tunable set you can move.",
  batch:
    "Batch submission spends provider credit hours later, when the demo " +
    "workspace no longer exists. Sign up to use it.",
  judge:
    "The LLM judge grades shadow events in bulk against an answer model, which " +
    "the demo doesn’t carry a key for. The would-hit queue is yours: this " +
    "workspace was published with real events waiting for a verdict, and each " +
    "one you decide re-sweeps the threshold it recommends.",
  sweep:
    "The cache-key sweep re-embeds the whole question bank in every candidate " +
    "model, so it's off in the demo, and this build was published without the " +
    "sweep's result. The cache it was measuring is live: ask a banked question " +
    "two different ways and watch the second one hit.",
  keyModel:
    "Switching the cache-key model changes which vector-space every incoming " +
    "question is matched in, and backfilling re-embeds this config's banked " +
    "questions under it — spend the demo doesn't carry, and a write the next " +
    "visitor would inherit. The cache it would be changing is live either way: " +
    "ask a banked question two different ways and watch the second one hit.",
  pairs:
    "Writing NEW question pairs needs an answer model to phrase each variant, " +
    "which the demo doesn't carry a key for, and this build was published " +
    "without a bank of them. The would-hit queue is stocked either way: " +
    "this workspace carries a sample of real shadow events waiting for a " +
    "verdict, which is what pairs are generated to produce.",
  probeReplay:
    "Stocking the queue replays generated question variants through the cache, " +
    "embedding each one — a spend the demo doesn’t carry. It also isn’t " +
    "needed here: this workspace was published with a sample of real shadow " +
    "events already waiting, which is what a signed-up account uses this to " +
    "build for itself. The would-hit queue is the result either way.",
  // Not an action anyone takes — the outcome of taking enough of them. It shares
  // this table because it shares the transport: a 403 with a sentence, from the
  // one catch site.
  budget:
    "This demo workspace has spent its embedding budget. Everything you've done " +
    "is still here to look at — sign up with your own key to keep asking.",
} as const;

export type DemoAction = keyof typeof DEMO_ACTIONS;

// THE OTHER HALF OF `appraise`, and the reason that sentence is now a fallback
// rather than the normal case (phase 6.3).
//
// A guest's Appraise → Models is not empty any more: lib/demo/clone step 5c
// copies the replay's RESULT, so the table renders real rankings. But those
// numbers were computed on the master before the clone, and a visitor who
// assumes their own workspace produced them would be wrong about the one thing
// that matters here — this table cannot move, because the vectors it would need
// are the 107 MB the clone deliberately leaves behind.
//
// So this is the same rule as every sentence above, pointed the other way: a
// refusal may not point at something absent, and a MEASUREMENT may not imply a
// computation that did not happen for this workspace.
export const PUBLISHED_REPLAY_NOTE =
  "Published measurement: every model was ranked over this corpus before the " +
  "workspace was cloned for you. Re-running it needs each model's cached " +
  "vectors for every chunk — 92 MB the demo doesn't hand out — so these rows " +
  "are fixed. The Eval tab is the part you can move.";

// THE OTHER HALF OF `sweep` (phase 2 of docs/demo-cache-lab-plan.md), and the
// exact analogue of PUBLISHED_REPLAY_NOTE above one panel over.
//
// A guest's §4 is not three disabled buttons any more: clone step 5d copies the
// sweep's RESULT (0077), so the leaderboard renders real rankings. Two things
// then need saying at once, and they pull in opposite directions — which is why
// this is a note rather than a refusal.
//
// The TABLE is a published measurement and cannot move: re-deriving it means
// re-embedding the pooled pair set under every candidate, on keys the demo does
// not hold. The SLIDER, though, genuinely is live, and understating that would
// be its own kind of dishonesty — selectFromCurve runs client-side over the
// banked curves, and lib/rag/publishedSweep thins them to precisely the 101
// positions the slider can reach, so every number it displays is the number a
// real run would have displayed. Exact, not approximated; see thinCurve.
export const PUBLISHED_SWEEP_NOTE =
  "Published measurement: this sweep ran once on the operator's account, " +
  "before the workspace was cloned for you — re-running it would re-embed " +
  "the whole pair set under every candidate model. The precision slider is " +
  "live and exact: each row is re-derived here from the curves the sweep " +
  "banked, at every position the slider can reach. The table itself is fixed.";

// PHASE 3's reveal, beside the pair counts. The sibling of PUBLISHED_SWEEP_NOTE:
// same "the reveal is real, the writing is not" split that `generate` makes for
// the question bank, pointed at semantic_cache_pairs.
export const PUBLISHED_PAIRS_NOTE =
  "These pairs were generated and audited on the operator's account and " +
  "published with this workspace, so \u201cGenerate\u201d hands you ones that " +
  "were already paid for instead of writing new ones. The pairs are real; only " +
  "the writing is skipped.";

// PHASE 3's warning, and it is not decoration. The leaderboard is banked, so it
// is fixed no matter what the pair count does — and a rising pair count sitting
// above a table that never moves reads as a bug in the sweep rather than as the
// deliberate design of the publish. Left unsaid, the demo's most distinctive
// measurement looks broken at precisely the moment a visitor interacts with it.
export const REVEALED_PAIRS_NOTE =
  "Revealing more pairs doesn't move the leaderboard — that sweep was " +
  "scored once, on the operator's account, over the full pooled set. This " +
  "workspace carries a capped sample of it, and the count here is how much of " +
  "that sample you've uncovered, not the input to a fresh scoring run.";

// PHASE 3b, beside the pair screen. No second published table exists or is
// needed: the screen verdict and the quarantine flag are COLUMNS on
// semantic_cache_pairs, so cloning the pair table is the publish. The clone
// blanks them on the rows the guest is meant to act on (clearIfQueued's move in
// step 5b), which is what makes the panel's "unscreened" count mean something
// for a guest and makes pressing the button resolve to F3's audited answer
// rather than to a guess.
export const PUBLISHED_SCREEN_NOTE =
  "Screening asks a model whether each pair is labelled correctly, which the " +
  "demo doesn't carry a key for — and doesn't need to here. These pairs " +
  "were screened on the operator's account and their verdicts published " +
  "alongside them, quarantine included, so this fills in the audited answer " +
  "rather than a guess.";

// PHASE 4, and the ONE sentence on this page that promises something live.
//
// The bulk job stays blocked with DEMO_ACTIONS.probeReplay unchanged — its cap
// is 40 probes fired automatically, i.e. 40 embeddings nobody asked for. A
// SINGLE probe is one embedQueryCached plus one indexed single-row lookup: the
// same ~25 KB budget as a guest asking a question, which the table at the top of
// this file already calls "the demo".
//
// The unjudged part is the point, not a limitation to apologise for. Probe rows
// land verdict = null and the curve counts judged rows only (lib/rag/probeReplay's
// central rule), which is exactly what makes a guest-authored probe honest: their
// question sits in the queue with nothing claiming to have judged it.
export const GUEST_PROBE_NOTE =
  "This part is live. A probe embeds one question variant and looks it up in " +
  "the cache — a single embedding, the same budget as asking a question, " +
  "which the demo does pay for. It lands in the queue below with no verdict on " +
  "purpose: nothing has judged it but you. Stocking the queue in bulk is the " +
  "part that stays off.";

// PHASE 5 — one line at the top of the page, because the page is now half
// published and half live and a visitor has no way to tell which half they are
// touching. The demo's copy rule applies as everywhere else: every clause here
// points at something lib/demo/clone actually carries — the shadow queue and
// its curve (step 5b), the sweep (step 5d).
export const LIVE_HALF_NOTE =
  "Which half is live: the would-hit queue is yours — this workspace was " +
  "published with real events waiting, and every verdict you give re-sweeps " +
  "the threshold it recommends. Probing one pair is live too, and lands a new " +
  "row in that queue. The pair bank hands you pairs already generated, and the " +
  "cache-key leaderboard was measured on the operator's account and is fixed. " +
  "Generating anything new needs an account with its own keys.";

export class DemoBlockedError extends Error {
  readonly action: DemoAction;
  constructor(action: DemoAction) {
    super(DEMO_ACTIONS[action]);
    this.name = "DemoBlockedError";
    this.action = action;
  }
}

export function isDemoBlocked(err: unknown): err is DemoBlockedError {
  return err instanceof DemoBlockedError;
}

// THE GATE. One line at the top of every blocked entry point, inside the scope
// (it reads the caller's own profile row).
//
// Fails CLOSED in the sense that matters: a real account never reaches the
// throw, and a guest always does. It cannot be turned into a spend by a forged
// parameter because it takes no input but the action's name.
export async function assertDemoAllows(action: DemoAction): Promise<void> {
  if (await isGuest()) throw new DemoBlockedError(action);
}

// The same question without the throw, for UI that wants to render a button
// disabled rather than let it fail. The gate above is still the enforcement —
// a disabled button is a courtesy, not a boundary.
export async function demoBlocks(): Promise<boolean> {
  return isGuest();
}
