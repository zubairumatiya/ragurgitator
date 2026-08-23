// THE TWO MARKERS A PUBLISH WRITES AND THE APP READS BACK.
//
// Phase 4 of docs/demo-analytics-plan.md opens re-scoring and autotune to a
// guest, which is only affordable because a guest's workbench is SCOPED rather
// than gated: twelve questions are live and the other ~460 are frozen. Both
// halves of that scope are a string in a row, and both strings are load-bearing
// enough to deserve a module of their own rather than a literal at each site.
//
// WHY A REASON STRING RATHER THAN AN isGuest() CHECK. The obvious shape for
// "scope scoring to the twelve" is a guest branch inside evalStore's question
// queries. It is the wrong shape: it puts the demo into the store layer, and it
// makes every scoped query a thing that behaves differently depending on who is
// asking — which is exactly the property that makes a bug in it invisible in
// every test that does not provision a guest. Instead the SNAPSHOT writes the
// scope down as data (config_question_ignores rows carrying FROZEN_REASON), and
// the store just excludes frozen rows. A real account has no such rows, so its
// behaviour is unchanged by construction rather than by a branch.
//
// WHY IT REUSES config_question_ignores (0014) rather than a new table. An
// ignore already means precisely "out of the rates, out of autotune targeting,
// still visible and still scored" — the three properties the frozen set needs —
// and `reason` already distinguishes a human's click from the holdout draw
// (0061). A third value is the change this needs; a fourth table would be a
// second thing to keep in agreement with the first.
import "server-only";

// config_question_ignores.reason on the ~460 questions a guest may look at but
// not move. Distinct from a human's null reason and from HOLDOUT_REASON, so the
// three cannot be confused: `syncHoldout` deletes by reason, and a guest
// un-ignoring a question must not be able to reach these.
export const FROZEN_REASON = "demo_frozen";

// eval_runs.notes on the single row scripts/demo-snapshot.ts freezes at publish
// time — the "As published" card's source.
//
// It has to be findable BY NAME rather than by "the newest run", because phase 4
// is what lets a guest write runs of their own: a re-score or an autotune
// inserts a fresh eval_runs row, and "newest" would quietly relabel the
// visitor's own result as the published build's headline. That is the one lie
// this whole section exists to stop telling.
export const PUBLISHED_RUN_NOTE = "as published";

// HOW MANY BANKED QUESTIONS A PUBLISH CARRIES (phase 6.1).
//
// The third piece of the demo's scope, and the least obvious one. `Add cached`
// is the ONLY way a guest can add a question — generation needs a key the demo
// does not carry — so the size of the published question_cache is a hard ceiling
// on how far the tunable set can grow, and therefore on what autotune runs over.
// Without it the ceiling is whatever the master happened to bank: 43 today, an
// unknown number after the next generation run on the master, and nothing in the
// publish would report the difference.
//
// TWELVE, to match the tunable set: the worst case a guest can reach is 24
// questions, exactly twice the number phase 4 sized and measured autotune
// against. A cap that moves with the master's bookkeeping is not a cap.
//
// It is applied in lib/demo/clone step 4e, at PUBLISH time, for the same reason
// FROZEN_REASON is: the scope is data in the build, not a branch in the app.
export const BANKED_QUESTION_CAP = 12;
