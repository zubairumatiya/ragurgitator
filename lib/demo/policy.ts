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
//             chunkEmbeddings() behind re-score and the efficacy gate, and
//             /appraise → Models' replay from cached vectors. These are cheap in
//             dollars and ruinous in bytes, which is why the gate covers more
//             than the obviously expensive levers.
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
export const DEMO_ACTIONS = {
  ingest:
    "Uploading and ingesting documents is off in the demo — it would spend the " +
    "shared embedding key. The corpus you're looking at is already ingested; " +
    "sign up with your own keys to bring your own documents.",
  reconfigure:
    "Re-chunking or switching embedding model re-embeds the whole corpus, which " +
    "the demo doesn't pay for. Everything else on this page is live.",
  autotune:
    "Autotune re-embeds every chunk it tries, so it's off in the demo. The " +
    "results of a real run are on the Eval tab.",
  generate:
    "Question generation needs an answer-model key, which the demo doesn't " +
    "carry. The question bank you're looking at was generated the same way.",
  rescore:
    "Re-scoring pulls every chunk vector back out of the database — cheap in " +
    "dollars, expensive in bandwidth — so it's off in the demo. The scores " +
    "shown are real.",
  override:
    "Per-chunk overrides re-embed the chunk and re-score the questions hanging " +
    "off it — a small version of the two things the demo doesn't pay for. The " +
    "override panel still shows you what a real one did.",
  cluster:
    "Clustering downloads every chunk vector to fit centroids, so it's off in " +
    "the demo. Sign up with your own keys to run it on your corpus.",
  appraise:
    "The model comparison replays the whole corpus from cached vectors, which " +
    "the demo doesn't have the bandwidth for. The rankings shown are real.",
  batch:
    "Batch submission spends provider credit hours later, when the demo " +
    "workspace no longer exists. Sign up to use it.",
  sweep:
    "The cache-key sweep re-embeds the whole question bank in several models. " +
    "Its results are on the Appraise tab.",
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
