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

// HOW MANY BANKED QUESTIONS A PUBLISH CARRIES (phase 6.1, re-cut by
// docs/demo-question-bank-plan.md, widened by §3.2 of
// docs/demo-real-flow-plan.md).
//
// The third piece of the demo's scope, and since §3.2 the ONLY one with anything
// in it. `Add cached` is the only way a guest can add a question — generation
// needs a key the demo does not carry — so the size of the published
// question_cache is a hard ceiling on how far the board can grow, and therefore
// on what scoring, nDCG and autotune run over.
//
// SIXTY, WHICH IS THE WALK ITSELF. It used to be a cap on someone else's set,
// then the size of a spare bank sitting beside a build of 460 live questions.
// The build now ships with NO questions at all: the publish banks these and
// deletes every eval_questions row it just copied, so a guest's board starts
// empty and the first press of "Add cached" is what fills it. Sixty is not a
// budget, it is the board — the 30 chunks lib/demo/tunable.ts selects, times the
// two difficulties the master generated for each of them (Q3: 236 chunks, 472
// labels, exactly two per chunk).
//
// Step 4e still applies it, because that is the step that copies the snapshot's
// bank into each guest and a cap there is what keeps a hand-edited snapshot from
// widening the scope silently.
export const BANKED_QUESTION_CAP = 60;

// HOW MUCH OF THE SHADOW LOG A PUBLISH CARRIES (phase 6.2).
//
// The calibration curve is the app's most distinctive measurement and the demo
// shipped it empty, because semantic_cache_shadow was in neither the clone's copy
// list nor its "deliberately not cloned" list — it was simply missed. These caps
// are what lets it in without handing every guest the master's whole telemetry
// table (335 rows, ~300 KB, and growing every time the operator asks a question).
//
// WHY TWO NUMBERS RATHER THAN ONE. The two origins are not two halves of one
// sample, they are two different measurements that happen to share a table (0069),
// and the demo needs both for opposite reasons:
//
//   traffic  what this account's REAL questions did — 91 judged, 91 accepted, and
//            that census is the honest headline (F7). Its curve is one-class and
//            therefore FLAT, which is the correct thing for a visitor to see by
//            default: it is what the app recommends serving on.
//   probe    engineered near-misses, half of them hard negatives (F1/F3). This is
//            the only population with rejects in it, so it is the only one where
//            precision visibly trades against recall — the thing phase 6.2 exists
//            to put on screen. It is a WORST-CASE BOUND, never a setting, which is
//            why the panel will not offer its τ to the apply box.
//
// Sized against the curve, not against the disk: below ~100 rows a stratum's
// accept rate per similarity band gets noisy enough that the curve develops steps
// the master's does not have, and a demo whose distinctive chart is visibly
// wrong is worse than one that omits it. ~170 rows is ~150 KB per guest, against
// the ~1 MB of chunk rows that dominate a clone.
export const SHADOW_CURVE_CAP = { probe: 120, traffic: 40 } as const;

// AND HOW MANY ARRIVE UNJUDGED, so the human Accept/Reject queue has something in
// it on the first page load.
//
// This is the half that makes the panel a workbench rather than a poster. Judging
// is otherwise a spend (an LLM pass the demo will not pay for), but a HUMAN
// verdict is one UPDATE — so the queue is carved out of the gate and these rows
// are what it serves. They are drawn from `probe` and copied with the verdict
// CLEARED: the operator's own verdict is discarded on the way into a guest's
// private clone, because the point is for the visitor to supply it and watch the
// curve move.
//
// Above the shadow-log floor by construction (see clone step 5b). A sub-floor row
// judged by hand changes no curve — calibrationCurve drops that band — so a queue
// full of them would be a control that visibly does nothing.
export const SHADOW_QUEUE_CAP = 12;

// HOW MANY GENERATED PAIRS A PUBLISH CARRIES, AND HOW MANY IT HOLDS BACK
// (phases 3 and 3b of docs/demo-cache-lab-plan.md, applied in clone step 5e).
//
// semantic_cache_pairs is the third table that spent the demo's life in neither
// of clone.ts's lists, and it is the one §4's two remaining buttons read. The
// caps split the master's set into three parts, and each number answers a
// different question:
//
//   PAIR_VISIBLE_CAP  what the panel's pair counts SAY on first load. Sized like
//     SHADOW_CURVE_CAP — big enough that the (same/different) × (paraphrase/
//     hard-negative) mix is recognisably the operator's, small enough that a
//     two-hour workspace is not carrying the master's whole generation history.
//   PAIR_BANK_CAP     what "Generate pairs" can still reveal. It is the ceiling
//     on the slider the same way BANKED_QUESTION_CAP is the ceiling on "Add
//     cached": the guest's reveal is real, the writing is not, so the run-out
//     point has to be a number written down here rather than whatever the master
//     happened to have generated.
//   PAIR_BLANK_CAP    how many cloned rows arrive UNSCREENED, verdicts stashed
//     in demo_pair_bank (0078). The exact analogue of SHADOW_QUEUE_CAP: the queue
//     that makes a button do something. Small, because every blanked row is a
//     row whose audited label is off the table until the guest presses screen.
export const PAIR_VISIBLE_CAP = 60;
export const PAIR_BANK_CAP = 20;
export const PAIR_BLANK_CAP = 6;
