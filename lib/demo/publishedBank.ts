// THE QUESTIONS "ADD CACHED" HANDS A GUEST — chosen by the publish, not inherited
// from the master (docs/demo-question-bank-plan.md).
//
// "Bulk actions → Add question → Add cached" is the ONE way a guest can add a
// question: generation needs an answer-model key the demo does not carry, so the
// route carves `cachedOnly` out of the gate and fillChunksFromCache serves
// whatever question_cache holds for the passage. That makes the published bank a
// feature of the build, and until this module it was an accident of one.
//
// WHAT IT WAS. clone.ts step 4e copies question_cache rows that happen to exist
// for published chunk text, one per hash, capped at BANKED_QUESTION_CAP. Every
// property a visitor would notice — which documents the questions are about, what
// difficulty they are, whether the chunk already carries a question — was
// whatever the master's generation history left behind. Measured on the build
// published 2026-08-29: twelve questions, all from world-war-i.md, all `medium`,
// three of them landing on chunks that already had a tunable question. The
// publish even warns about the first of those (bankedSpread < 2) and the build
// shipped with the warning firing, because nothing could act on it: re-publishing
// does not change what the master banked.
//
// WHAT IT IS NOW. The publish CONSTRUCTS the bank out of the build's own
// questions and then EMPTIES THE BUILD, so pressing the button is an addition
// rather than a near-duplicate. Both halves are needed: selectNewQuestions drops
// a banked question whose wording is already labeled to that chunk, so banking
// without deleting is how a bank counts twelve and adds three.
//
// AND SINCE §3.2 OF docs/demo-real-flow-plan.md THE DELETE IS TOTAL. The build no
// longer ships a board of live questions with a small bank beside it; it ships an
// EMPTY board and a bank of sixty, and the visitor's first press is what puts
// questions on it. So this module's delete stopped being "take the banked ones
// back out" and became "leave nothing behind" — every eval_questions row in the
// published account goes, and eval_labels, eval_results, eval_rankings and
// eval_question_embeddings cascade with it. That cascade is the whole reason the
// cold-start payload collapses.
//
// ORDER MATTERS, AND IT IS THE CALLER'S JOB: copy, then CORRECT, then empty.
// scripts/demo-snapshot's freezePublishedRun reads the copied scores back to
// compute the "As published" card, so it has to run before this does — the
// headline is over what the master measured, not over what a visitor has built,
// and there is nothing left to measure afterwards.
//
// WHY IT RUNS ON THE SNAPSHOT, AFTER THE CLONE, rather than on the master before
// it. The master keeps every question it paid for — this is a property of the
// BUILD, not of the corpus. And in the snapshot the selection is already written
// down as data: clone step 5g remapped the published BOARD into the snapshot's id
// space, so the scope is a row rather than a second copy of a decision that could
// drift. Every id here is a snapshot id, so nothing needs mapping.
import "server-only";

import { createHash } from "node:crypto";

import { privilegedSql } from "@/lib/db";
import { BANKED_QUESTION_CAP } from "@/lib/demo/frozen";
import { composeBank } from "@/lib/demo/publishedBankCore";
import { QUOTAS } from "@/lib/demo/tunable";
import { QUESTION_PROMPT_VERSION, questionRequestParams, type Difficulty } from "@/lib/rag/eval";
import { estimateTokens } from "@/lib/rag/pricing";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

// One question the publish is about to move out of the build and into the bank.
// The row as the candidate query returns it; `chunkText` is joined on afterwards
// for the twelve that survive composeBank.
export type BankCandidateRow = {
  questionId: string;
  question: string;
  expectedAnswer: string | null;
  difficulty: string;
  chunkId: string;
  documentId: string;
  fileName: string;
  // found_rank of its last baseline score, 99 for "missed" — the same tier
  // lib/demo/tunable.ts weights its quota table by.
  tier: number;
};

export type BankPick = BankCandidateRow & { chunkText: string };

export type BankReport = {
  banked: number;
  removed: number; // eval_questions rows deleted — ALL of them, not just the banked
  remaining: number; // and what is left, which must be zero
  documents: number;
  difficulties: string[];
  inherited: number; // bank rows the publish clone copied, replaced by these
  tiers: { tier: number; n: number }[];
};

// WHICH SIXTY. Three rules, and each one is answering a complaint the published
// build actually earned:
//
//   THE BOARD, AND ONLY THE BOARD. The candidate set is every question labeled to
//     a chunk in the published board scope (§3.1). It used to be the complement —
//     "not a chunk the tunable set already uses" — because the bank was a set of
//     SPARES sitting beside a live build. There is no live build any more: the
//     board's own questions are the walk, so excluding them would bank the one
//     set a visitor must be able to reach.
//   ONE ROW PER (CHUNK, DIFFICULTY). question_cache is keyed by
//     (…, difficulty, text_hash, …, slot), and the master's second question about
//     a passage is a different DIFFICULTY rather than a harder restatement (Q5).
//     So a chunk contributes its easy one and its medium one and stops — two
//     wordings of the same difficulty about the same passage would collide on the
//     key, and `slot` exists for a case this selection does not create.
//   THE BOARD'S OWN COMPOSITION AND SPREAD, unchanged: the same QUOTAS
//     lib/demo/tunable.ts weights the board by, and a document counter shared
//     across every quota. On today's corpus the two rules meet exactly — 30 board
//     chunks × 2 difficulties = 60 = the cap — so composeBank has nothing to
//     choose between; it is kept because a corpus with three difficulties per
//     chunk would put it back in charge, and a bank chosen worst-first is the
//     failure it was written for.
//
// The last two live in composeBank (publishedBankCore.ts), which is pure and
// tested; this query's job is to hand it one candidate per eligible
// (chunk, difficulty) in a stable order. Ordering is md5(id) at every tie,
// matching tunable.ts: stable across re-publishes of an unchanged build, and
// uncorrelated with ingest order (which correlates with document, which would
// defeat the spread).
//
// `board` is the snapshot's own chunk ids, read back off the demo_replay row
// clone step 5g remapped. An EMPTY board returns nothing rather than falling
// through to the whole corpus: a build whose board did not survive the remap must
// publish an empty bank the operator is warned about, not a bank of 60 arbitrary
// questions that looks exactly like a working one.
export async function selectBankable(
  configId: string,
  baseModel: string,
  board: string[],
  cap: number = BANKED_QUESTION_CAP,
): Promise<BankPick[]> {
  if (board.length === 0) return [];
  let table: string;
  try {
    table = chunksTable(baseModel, modelDimension(baseModel));
  } catch {
    return [];
  }
  const candidates = await privilegedSql.unsafe<BankCandidateRow[]>(
    `with latest as (
       select distinct on (r.eval_label_id, r.k)
              r.eval_question_id as id,
              coalesce(r.found_rank, 99) as tier,
              l.source_chunk_id as chunk,
              q.document_id,
              q.question,
              q.expected_answer,
              q.difficulty
         from eval_results r
         join eval_labels l on l.id = r.eval_label_id
         join document_embeddings de on de.id = l.document_embedding_id
         join eval_questions q on q.id = r.eval_question_id
        where de.config_id = $1
          and r.retrieval_state = 'baseline' and not r.is_baseline
          -- THE SCOPE, and the only one. The frozen/tunable split used to be the
          -- candidate boundary here; the publish is about to delete both halves,
          -- so the board row is what says which passages the walk is over.
          and l.source_chunk_id = any($2::uuid[])
        order by r.eval_label_id, r.k, r.scored_at desc
     ),
     -- One per (chunk, difficulty): worst-scoring first, then whichever carries an
     -- expected answer. The answer is a PREFERENCE and not a filter —
     -- question_cache's column is nullable and the eval scores retrieval, so a
     -- question without one is still worth banking; it is just the weaker of two
     -- equals.
     per_pair as (
       select distinct on (chunk, difficulty) * from latest
        order by chunk, difficulty, tier desc, (expected_answer is null), md5(id::text)
     )
     select p.id::text          as "questionId",
            p.question          as question,
            p.expected_answer   as "expectedAnswer",
            p.difficulty        as difficulty,
            p.chunk::text       as "chunkId",
            p.document_id::text as "documentId",
            d.file_name         as "fileName",
            p.tier::int         as tier
       from per_pair p
       join documents d on d.id = p.document_id
      order by p.tier desc, md5(p.id::text)`,
    [configId, board] as never[],
  );

  const picks = composeBank(candidates, QUOTAS, cap);
  if (picks.length === 0) return [];

  // The chunk text last, and only for what survived: it is what the bank is KEYED
  // by (sha256 of the exact text, 0055) and what the token estimate re-prices the
  // generation from, but pulling it for every candidate would drag the whole
  // corpus through the script to use a fraction of it.
  const texts = await privilegedSql.unsafe<{ id: string; text: string }[]>(
    `select id::text as id, "text" from "${table}" where id = any($1::uuid[])`,
    [picks.map((p) => p.chunkId)] as never[],
  );
  const byChunk = new Map(texts.map((t) => [t.id, t.text]));
  return picks.flatMap((p) => {
    const text = byChunk.get(p.chunkId);
    // A candidate whose chunk vanished between the two queries is dropped rather
    // than banked under a hash of nothing — impossible inside a publish, and a
    // silent mis-key if it ever were not.
    return text === undefined ? [] : [{ ...p, chunkText: text }];
  });
}

// Same convention as questionCache.hashChunkText — sha256 hex over the exact
// UTF-8 chunk text. Recomputed here rather than imported because that module is
// request-scoped (it reads activeUserId), and this runs in a publish script.
const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// WHAT A REUSED QUESTION SAVED, re-derived rather than left at zero.
//
// question_cache carries the generating call's usage so "Add cached" can price
// the reuse into savings_totals. These rows were never a call — they are
// questions the master generated long ago, banked after the fact — so there is no
// `usage` to copy. The honest number is the one the call WOULD have cost, and it
// is derivable: questionRequestParams rebuilds the exact prompt the generator
// sends for this passage at this difficulty, and estimateTokens is the same
// ≈4-chars-per-token estimate the app already prices every embed with.
//
// Deliberately NOT zero. A guest's Add cached would otherwise report twelve
// questions reused and $0.000000 saved, in a workbench whose whole subject is
// what the levers save.
function usageFor(pick: BankPick, llmModel: string): { input: number; output: number } {
  const params = questionRequestParams(
    pick.chunkText,
    1,
    pick.difficulty as Difficulty,
    llmModel,
  );
  const system = Array.isArray(params.system)
    ? params.system.map((b) => ("text" in b ? b.text : "")).join("")
    : String(params.system ?? "");
  const user = params.messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("");
  // The response is the structured-output JSON, not the bare question: that is
  // what the model actually emitted and what its output tokens were spent on.
  const answered = JSON.stringify({
    questions: [{ question: pick.question, expected_answer: pick.expectedAnswer ?? "" }],
  });
  return {
    input: estimateTokens(system) + estimateTokens(user),
    output: estimateTokens(answered),
  };
}

// Replace the snapshot's question bank with `picks`, and EMPTY the published
// build's question set.
//
// ONE TRANSACTION, because the two halves are one fact: a banked question still
// sitting in the build is a row "Add cached" will count and then decline to add
// (selectNewQuestions dedupes on wording), and a deleted question with no bank
// row behind it is a question the publish simply lost.
//
// THE DELETE IS THE WHOLE BUILD, not the picks (§3.2). Deleting only the sixty
// would ship a board of 400 questions a visitor did not add and cannot move,
// under a banner saying the walk starts empty. Everything else about a question —
// its label, its published score, its truth ranking, its frozen-ignore row, its
// embedding — hangs off eval_questions and cascades, which is what collapses the
// cold-start payload from 353 KB to a board with nothing on it.
//
// The picks are read out of the build BEFORE this runs (selectBankable) and are
// carried here as values, so the delete cannot take the bank with it.
//
// The inherited rows go first. The publish clone's step 4e has already copied
// whatever the master had banked for these chunks; leaving it would mean the
// guest clone's own step 4e picking twelve out of twenty-four by text hash, which
// is the accident this module exists to end.
export async function seedPublishedBank(
  snapshotId: string,
  llmModel: string,
  picks: BankPick[],
): Promise<BankReport> {
  return privilegedSql.begin(async (tx) => {
    const inherited = await tx`
      delete from question_cache where user_id = ${snapshotId}
    `;
    // NOTHING BANKED, NOTHING DELETED — deliberately, and it is the one place
    // this function declines to do half its job. A build with no bank and no
    // questions is a demo with no way to put anything on the board; leaving the
    // copied questions in place ships the PREVIOUS shape (a full, scoped board)
    // while the publish prints the warning that says why. A broken walk beats a
    // blank one.
    if (picks.length === 0) {
      const [{ count: remaining }] = await tx<{ count: number }[]>`
        select count(*)::int as count
          from eval_questions q join documents d on d.id = q.document_id
         where d.user_id = ${snapshotId}
      `;
      return {
        banked: 0,
        removed: 0,
        remaining,
        documents: 0,
        difficulties: [],
        inherited: inherited.count ?? 0,
        tiers: [],
      };
    }

    const rows = picks.map((p) => {
      const usage = usageFor(p, llmModel);
      return {
        user_id: snapshotId,
        llm_model: llmModel,
        difficulty: p.difficulty,
        text_hash: hashText(p.chunkText),
        prompt_version: QUESTION_PROMPT_VERSION,
        // Always 0: the selection is one question per (chunk, difficulty), so no
        // two picks share a (hash, difficulty), and the inherited rows are gone.
        slot: 0,
        question: p.question,
        expected_answer: p.expectedAnswer,
        input_tokens: usage.input,
        output_tokens: usage.output,
      };
    });
    const banked = await tx`
      insert into question_cache ${tx(
        rows,
        "user_id",
        "llm_model",
        "difficulty",
        "text_hash",
        "prompt_version",
        "slot",
        "question",
        "expected_answer",
        "input_tokens",
        "output_tokens",
      )}
      on conflict do nothing
    `;

    // EVERY question in the published account, scoped by document owner because
    // that is the only column eval_questions carries — it has no user_id, and the
    // config map that would scope it lives one join further out through
    // eval_labels, which a question with no label would slip through.
    const removed = await tx`
      delete from eval_questions q
       using documents d
       where d.id = q.document_id and d.user_id = ${snapshotId}
    `;
    const [{ count: remaining }] = await tx<{ count: number }[]>`
      select count(*)::int as count
        from eval_questions q join documents d on d.id = q.document_id
       where d.user_id = ${snapshotId}
    `;

    const byTier = new Map<number, number>();
    for (const p of picks) byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + 1);
    const tiers = [...byTier]
      .map(([tier, n]) => ({ tier, n }))
      .sort((a, b) => b.tier - a.tier);

    return {
      banked: banked.count ?? 0,
      removed: removed.count ?? 0,
      remaining,
      documents: new Set(picks.map((p) => p.documentId)).size,
      difficulties: [...new Set(picks.map((p) => p.difficulty))].sort(),
      inherited: inherited.count ?? 0,
      tiers,
    };
  });
}
