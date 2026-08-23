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
//             /appraise → Models' replay from cached vectors. These are cheap in
//             dollars and ruinous in bytes, which is why the gate covers more
//             than the obviously expensive levers.
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
// `appraise` is read twice: as a 403 body, and as the Models tab's own empty
// state (app/appraise/models/page.tsx), so it has to work as a sentence standing
// alone on an otherwise blank panel.
//
// `generate` NOW POINTS AT A BUTTON, which is only honest because phase 6 made
// it true: lib/demo/clone step 4e copies question_cache, so "Bulk actions → Add
// question → Add cached" is a working, model-free way for a guest to add a
// question. That path is carved out of this gate in the route itself
// (app/api/eval/bulk-generate), because `cachedOnly` is the one form of that
// request that calls nothing.
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
    "chunk it is ranked against, so it's off in the demo, and no saved trials " +
    "were published with this workspace. The live measurement is on the Eval " +
    "tab: the tunable questions there are yours to re-score and autotune.",
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
    "The model comparison replays the whole corpus from cached vectors, which " +
    "the demo doesn't have the bandwidth for — so this workspace was published " +
    "without any saved trials, and there is nothing here to show you. The Eval " +
    "tab is where this demo measures itself: published scores for every " +
    "question, and a tunable set you can move.",
  batch:
    "Batch submission spends provider credit hours later, when the demo " +
    "workspace no longer exists. Sign up to use it.",
  sweep:
    "The cache-key sweep re-embeds the whole question bank in several models, " +
    "so it's off in the demo and its results weren't published with this " +
    "workspace. The cache it was measuring is live: ask a banked question two " +
    "different ways and watch the second one hit.",
  // Not an action anyone takes — the outcome of taking enough of them. It shares
  // this table because it shares the transport: a 403 with a sentence, from the
  // one catch site.
  budget:
    "This demo workspace has spent its embedding budget. Everything you've done " +
    "is still here to look at — sign up with your own key to keep asking.",
} as const;

export type DemoAction = keyof typeof DEMO_ACTIONS;

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
