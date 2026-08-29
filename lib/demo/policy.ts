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
// `judge` IS A FALLBACK NOW TOO (phase 5 of docs/demo-cache-replay-plan.md).
// Only the LLM half of that route was ever gated — a human verdict is one UPDATE
// and buys nothing from a provider — and phase 4 turned even that half into a
// replay: clone step 5b banks the verdicts the operator's own judge returned over
// the queued rows, so "Run judge over queue" applies them for free. This sentence
// is what a build published without those verdicts says, which is why it consoles
// with judging BY HAND rather than with the queue merely existing.
//
// `generate` NOW POINTS AT A BUTTON, which is only honest because phase 6 made
// it true: lib/demo/clone step 4e copies question_cache, so "Bulk actions → Add
// question → Add cached" is a working, model-free way for a guest to add a
// question. That path is carved out of this gate in the route itself
// (app/api/eval/bulk-generate), because `cachedOnly` is the one form of that
// request that calls nothing.
//
// `sweep` IS A FALLBACK, for exactly `appraise`'s reason. A guest's Appraise →
// Semantic caching §4 re-derives its leaderboard from the banked similarity
// matrix (0080) at whatever `n` they have reached, so pressing "Run sweep"
// replays real arithmetic instead of buying ~510 texts × every candidate model of
// embeddings on keys the demo does not hold.
//
// THE FALLBACK IS NOT HYPOTHETICAL, which is the whole reason this entry survived
// phase 5's copy pass. scripts/demo-snapshot captures the matrix only under
// --sweep — the cold-cache hour — and WARNS rather than fails when it is absent,
// so a routine cheap republish is exactly a build whose guests reach this line.
// Without it their click runs the real sweep on the operator's key.
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
// `pairs` IS `sweep`'s FALLBACK ONE SECTION UP, and stands or falls with the same
// artifact. "Generate pairs" walks a guest further into the banked matrix — the
// counts, the leaderboard and the pair-bank collision floor all re-derive from
// the `n` it moves — and the carve-out lives in app/api/semantic-cache/pairs,
// exactly as `cachedOnly` lives in bulk-generate. With no matrix there is nothing
// to walk, and this is what that visitor reads.
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
  // SPLIT OFF `generate` (§5 of docs/demo-real-flow-plan.md). Both halves of
  // this route need an answer-model key, so one entry covered them — but the
  // sentence a visitor read on "Add LLM nDCG rankings" was the one about
  // WRITING QUESTIONS, pointing them at "Add cached" for a button that has
  // nothing to do with re-ranking. A tooltip that answers a question nobody
  // asked is the same defect as a refusal pointing at an empty tab.
  llmRank:
    "Asking an LLM to re-order a question's top-k costs one answer-model call " +
    "per question, which the demo doesn't carry a key for. The ranking builder " +
    "on any question still opens: the aggregate ideal an LLM re-ranking would " +
    "be compared against is there, and it's the one the Eval tab's nDCG is " +
    "actually scored on.",
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
    "The LLM judge grades queued events in bulk against an answer model, which " +
    "the demo doesn’t carry a key for, and this build was published without " +
    "the verdicts that would stand in for it. Judging by hand still works and " +
    "is the same lever: every verdict you give re-pools the pair set the " +
    "leaderboard is scored on and re-sweeps the threshold it recommends.",
  sweep:
    "The cache-key sweep re-embeds the whole pair set in every candidate model, " +
    "so it's off in the demo — and this build was published without the " +
    "similarity matrix that would otherwise replay it here, cosine for cosine. " +
    "The cache it was measuring is live either way: ask a banked question two " +
    "different ways and watch the second one hit.",
  keyModel:
    "Switching the cache-key model changes which vector-space every incoming " +
    "question is matched in, and backfilling re-embeds this config's banked " +
    "questions under it — spend the demo doesn't carry, and a write the next " +
    "visitor would inherit. The cache it would be changing is live either way: " +
    "ask a banked question two different ways and watch the second one hit.",
  pairs:
    "Writing NEW question pairs needs an answer model to phrase each variant, " +
    "which the demo doesn't carry a key for, and this build was published " +
    "without the measurement that would otherwise let you walk one. The " +
    "would-hit queue is stocked either way: this workspace carries a sample of " +
    "real shadow events waiting for a verdict, which is what pairs are " +
    "generated to produce.",
  // THE ONLY ENTRY HERE WITH NO REPLAY BEHIND IT, and the only one a guest cannot
  // reach by pressing anything. A probe has to EMBED a question variant and look
  // it up live, so unlike the judge's verdicts there is nothing about it a publish
  // can bank — which is also why phase 5 removed the demo's single-probe button
  // rather than replaying it. Two doors, both shut: probeReplayTrigger self-checks
  // demoBlocks() so nothing auto-fires after a generate, and this sentence answers
  // a hand-written POST /api/jobs. That second door is the enforcing one.
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

// WHY THERE ARE NO OTHER NOTES HERE — phase 5 of docs/demo-cache-replay-plan.md.
//
// Six sentences used to live below this one, all of them explaining Appraise →
// Semantic caching to a guest: which half of the page was live, why “Generate”
// said Reveal, why the leaderboard above a rising pair count never moved. They
// were honest about the page as it was, and phases 1–4 made every one of them
// false. The leaderboard moves now; the pair count that moves it is the same
// count; the screen and the bulk judge resolve to the operator's own verdicts
// over the visitor's own `n`.
//
// So they are not rewritten, they are gone. A demo that behaves like the product
// has nothing to explain, and the global DemoBanner already says what a demo is
// and what the rule is (bounded levers on, unbounded off). PUBLISHED_REPLAY_NOTE
// survives because its panel genuinely cannot move: Appraise → Models needs the
// 107 MB of cached vectors the clone leaves behind, and a measurement that
// cannot be re-derived still owes the visitor a sentence saying so.

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

// The same question again, answered for a WHOLE PAGE at once — the sentences a
// guest's controls need in order to render themselves disabled instead of
// answering with a 403 three layers down.
//
// Why the sentences travel rather than the action names: DEMO_ACTIONS is the one
// copy of this wording, it is server-only, and a second copy on the client is a
// second copy to keep true. So the summary carries the text.
//
// NULL FOR A REAL ACCOUNT, never an empty object — same carve-out rule as
// lib/demo/replay's readers, so a non-guest payload is byte-for-byte what it was
// and there is no per-lap egress to account for.
export type DemoBlockedSentences = Partial<Record<DemoAction, string>>;

// What the Eval tab can actually reach. `unfreeze` is here even though the
// frozen questions hide their own Ignore button: the route gates every question,
// so a TUNABLE one's Ignore is a 403 too. Autotune is deliberately absent —
// it is not in DEMO_ACTIONS at all, because a guest may press it.
export const EVAL_DEMO_ACTIONS = [
  "generate",
  "rank",
  "llmRank",
  "tryModel",
  "override",
  "unfreeze",
  "reconfigure",
] as const satisfies readonly DemoAction[];

export async function demoBlockedSentences(
  actions: readonly DemoAction[],
): Promise<DemoBlockedSentences | null> {
  if (!(await demoBlocks())) return null;
  const out: DemoBlockedSentences = {};
  for (const a of actions) out[a] = DEMO_ACTIONS[a];
  return out;
}
