// START OVER — put a half-walked demo board back to the state it was cloned in.
//
// The walk (docs/demo-real-flow-plan.md) is a one-way sequence of presses: add
// the cached questions, score them, grade them, re-rank them, tune them. A
// visitor who has done half of it and wants to see the beginning again has
// nowhere to go — every button they need is a button they have already pressed.
//
// WHY IT IS A DELETE AND NOT A RE-PROVISION. The board's initial state is
// *defined* as "the bank, unspent": the publish empties the build's questions
// (lib/demo/publishedBank.ts) and hands the guest a question_cache of sixty, so
// a workspace with no eval_questions in it IS a fresh one. Re-provisioning would
// mint a second guest against the same address, and the per-address cap makes
// that a door that locks behind the visitor.
//
// WHAT COMES BACK, AND WHY EACH IS HERE:
//
//   eval_questions — the board itself. Labels, results, truth rankings, ignores
//     and question embeddings all hang off it and cascade, which is the same
//     cascade the publish relies on.
//   config_chunk_overrides — what ⚙ Auto tune installed. Cleared through
//     clearChunkOverride so the retrieval fingerprint and the change log move the
//     way they would for any other un-tuning; a board reset with the master's
//     winners still installed would offer the visitor an autotune step whose
//     "before" is already the "after".
//   eval_model_trials — the "Models tried" list the tuning replay writes beside
//     each override. Their per-question rows name eval_questions ids that are
//     about to stop existing, so leaving them would leave a panel of drilldowns
//     into nothing.
//   autotune_runs, and the visitor's eval_runs — the history panel. A guest is
//     cloned with NO autotune history and exactly one eval_runs row: the "As
//     published" snapshot, found by its note (PUBLISHED_RUN_NOTE) and deliberately
//     kept here. It is the master's measurement of the published build, not
//     something this visitor did, and it is what the frozen card reads.
//
// WHAT DOES NOT. The demo_replay shelves (the board scope, the nDCG ideals, the
// LLM rankings, the tuning winners) are the BUILD, not the visitor's work — they
// are what makes the second walk possible. And savings_totals is left alone:
// what a lever saved was really saved, and rewinding the board does not unspend
// it.
import "server-only";

import { PUBLISHED_RUN_NOTE } from "@/lib/demo/frozen";
import { isGuest } from "@/lib/demo/guest";
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { clearChunkOverride, listOverrides } from "@/lib/rag/overrideStore";

export type RestartReport = {
  questions: number; // board rows deleted (labels, scores, rankings cascade)
  overrides: number; // chunks put back to baseline
  trials: number;
  autotuneRuns: number;
  runs: number; // eval_runs deleted — never the "As published" one
};

// Guest-only, on lib/demo/replay.ts's rule and for a plainer reason than that
// one's: this is a destructive delete of a whole eval board, and a real account's
// board is their work. Returns null rather than throwing so the route can answer
// 403 in the shape it wants.
export async function restartGuestBoard(): Promise<RestartReport | null> {
  if (!(await isGuest())) return null;
  const cfg = activeConfig();

  // The overrides first, while the questions they were installed against are
  // still on the board: clearChunkOverride writes a change-log line naming the
  // chunk, and the ordering keeps that log readable ("cleared", then the board
  // goes) rather than describing a chunk nothing points at any more.
  const overrides = await listOverrides();
  let cleared = 0;
  for (const o of overrides) {
    if (await clearChunkOverride(o.sourceChunkId)) cleared++;
  }

  // eval_model_trials carries no config_id (0011); the document_embeddings join
  // IS the scope, exactly as deleteModelTrial has it.
  const trials = await sql`
    delete from eval_model_trials t
    using document_embeddings de
    where de.id = t.document_embedding_id and de.config_id = ${cfg.id}
    returning t.id
  `;

  const autotuneRuns = await sql`
    delete from autotune_runs where config_id = ${cfg.id} returning id
  `;

  // Everything EXCEPT the published snapshot. `is distinct from` rather than
  // `<>` because the ordinary snapshot path leaves notes null, and a null-blind
  // comparison would spare every run instead of the one row that matters.
  const runs = await sql`
    delete from eval_runs
    where config_id = ${cfg.id}
      and notes is distinct from ${PUBLISHED_RUN_NOTE}
    returning id
  `;

  // Scoped by document owner because that is the only column eval_questions
  // carries — the same reason seedPublishedBank empties the build this way.
  const questions = await sql`
    delete from eval_questions q
    using documents d
    where d.id = q.document_id and d.user_id = ${activeUserId()}
    returning q.id
  `;

  return {
    questions: questions.length,
    overrides: cleared,
    trials: trials.length,
    autotuneRuns: autotuneRuns.length,
    runs: runs.length,
  };
}
