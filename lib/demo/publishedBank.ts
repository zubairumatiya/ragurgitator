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
// WHAT IT IS NOW. The publish CONSTRUCTS the bank out of the build's own frozen
// questions and DELETES those questions from the build, so pressing the button is
// an addition rather than a near-duplicate. Both halves are needed:
// selectNewQuestions drops a banked question whose wording is already labeled to
// that chunk, so banking without deleting is how a bank counts twelve and adds
// three.
//
// WHY IT RUNS ON THE SNAPSHOT, AFTER THE CLONE, rather than on the master before
// it. The master keeps every question it paid for — this is a property of the
// BUILD, not of the corpus. And in the snapshot the selection is already written
// down as data: step 4d froze all-but-twelve, so "frozen" is the candidate set
// and "not frozen" is the tunable set, with no second copy of that decision to
// drift. Every id here is a snapshot id, so nothing needs mapping.
import "server-only";

import { createHash } from "node:crypto";

import { privilegedSql } from "@/lib/db";
import { BANKED_QUESTION_CAP, FROZEN_REASON } from "@/lib/demo/frozen";
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
  removed: number;
  documents: number;
  inherited: number; // bank rows the publish clone copied, replaced by these
  tiers: { tier: number; n: number }[];
};

// WHICH TWELVE. Three rules, and each one is answering a complaint the published
// build actually earned:
//
//   NOT A CHUNK THE TUNABLE SET ALREADY USES. Autotune reshapes CHUNKS, so a
//     second question on a chunk that already has one gives it nothing new to
//     search. This is tunable.ts's "one question per source chunk" rule applied
//     across the two sets instead of within one.
//   THE TUNABLE SET'S OWN COMPOSITION. Both halves of what a guest can move are
//     weighted by the same QUOTAS, so the twelve they add look like the twelve
//     they arrived with rather than like whatever was left over.
//   SPREAD ACROSS DOCUMENTS, counted across the quotas rather than inside each
//     one. The bank this replaced was twelve questions about one file.
//
// The last two live in composeBank (publishedBankCore.ts), which is pure and
// tested; this query's job is to hand it one candidate per eligible chunk in a
// stable order. Ordering is md5(id) at every tie, matching tunable.ts: stable
// across re-publishes of an unchanged build, and uncorrelated with ingest order
// (which correlates with document, which would defeat the spread).
export async function selectBankable(
  configId: string,
  baseModel: string,
  cap: number = BANKED_QUESTION_CAP,
): Promise<BankPick[]> {
  let table: string;
  try {
    table = chunksTable(baseModel, modelDimension(baseModel));
  } catch {
    return [];
  }
  const candidates = await privilegedSql.unsafe<BankCandidateRow[]>(
    `with tunable_chunks as (
       select distinct l.source_chunk_id as chunk
         from eval_labels l
         join document_embeddings de on de.id = l.document_embedding_id
        where de.config_id = $1
          and not exists (
            select 1 from config_question_ignores i
             where i.config_id = $1 and i.eval_question_id = l.eval_question_id
          )
     ),
     latest as (
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
          -- The candidate set IS the frozen set: step 4d wrote it, so this asks
          -- the build what it published rather than re-deriving the twelve.
          and exists (
            select 1 from config_question_ignores i
             where i.config_id = $1 and i.eval_question_id = q.id and i.reason = $2
          )
          and l.source_chunk_id not in (select chunk from tunable_chunks)
        order by r.eval_label_id, r.k, r.scored_at desc
     ),
     -- One per chunk: worst-scoring first, then whichever carries an expected
     -- answer. The answer is a PREFERENCE and not a filter — question_cache's
     -- column is nullable and the eval scores retrieval, so a question without
     -- one is still worth adding; it is just the weaker of two equals.
     per_chunk as (
       select distinct on (chunk) * from latest
        order by chunk, tier desc, (expected_answer is null), md5(id::text)
     )
     select p.id::text          as "questionId",
            p.question          as question,
            p.expected_answer   as "expectedAnswer",
            p.difficulty        as difficulty,
            p.chunk::text       as "chunkId",
            p.document_id::text as "documentId",
            d.file_name         as "fileName",
            p.tier::int         as tier
       from per_chunk p
       join documents d on d.id = p.document_id
      order by p.tier desc, md5(p.id::text)`,
    [configId, FROZEN_REASON] as never[],
  );

  const picks = composeBank(candidates, QUOTAS, cap);
  if (picks.length === 0) return [];

  // The chunk text last, and only for the twelve: it is what the bank is KEYED
  // by (sha256 of the exact text, 0055) and what the token estimate re-prices the
  // generation from, but pulling it for every candidate would drag the whole
  // corpus through the script to use 5% of it.
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

// Replace the snapshot's question bank with `picks`, and take those questions out
// of the published build.
//
// ONE TRANSACTION, because the two halves are one fact: a banked question still
// sitting in the build is a row "Add cached" will count and then decline to add
// (selectNewQuestions dedupes on wording), and a deleted question with no bank
// row behind it is a question the publish simply lost.
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
    if (picks.length === 0) {
      return {
        banked: 0,
        removed: 0,
        documents: 0,
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
        // Always 0: the selection is one question per chunk, so no two picks
        // share a (hash, difficulty), and the inherited rows are already gone.
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

    // The labels, the published scores and the frozen-ignore row all cascade off
    // eval_questions, so this is the whole removal.
    const removed = await tx`
      delete from eval_questions where id = any(${picks.map((p) => p.questionId)}::uuid[])
    `;

    const byTier = new Map<number, number>();
    for (const p of picks) byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + 1);
    const tiers = [...byTier]
      .map(([tier, n]) => ({ tier, n }))
      .sort((a, b) => b.tier - a.tier);

    return {
      banked: banked.count ?? 0,
      removed: removed.count ?? 0,
      documents: new Set(picks.map((p) => p.documentId)).size,
      inherited: inherited.count ?? 0,
      tiers,
    };
  });
}
