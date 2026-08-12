// QUESTION CACHE — generated eval questions, banked per user and keyed on the
// hash of the passage they were written for, so a question is authored once per
// account rather than once per config (0055).
//
// Generation is already idempotent WITHIN a config (the "Top up" gap query keeps
// only chunks below target), but it's config-scoped, so a second config over the
// same corpus sees every slot as missing and re-buys the whole set. This module is
// what makes that free.
//
// BANKING IS AUTOMATIC, SERVING IS NOT. Every generation banks what it paid for,
// but nothing reads the cache on its own: serving happens only via "Bulk actions →
// Add question → Add cached". Reuse hands you wording authored under another
// config, so it stays a deliberate act rather than a background default.
//
// A HIT IS EXACT. Only the chunk text, difficulty, count and model reach the
// generator — no temperature, no seed, no user-editable prompt — so a row keyed on
// sha256(chunk text) at the same difficulty and model IS a question for that
// passage. Approximate reuse (remapping onto a differently-chunked passage) is
// reconfigure.ts's salvage and is deliberately not done here.
//
// Shape follows embedCache.ts:
//   - reads are scoped `where user_id = activeUserId()` and RETHROW anything that
//     isn't a missing table, because silently reporting a miss is a silent bill;
//   - writes are best-effort — isolated() so a failure can't poison the caller's
//     transaction, `on conflict do nothing` for concurrent identical rows, and
//     warn-and-carry-on because a lost row costs one future generation;
//   - no L1 map. These rows are small and the lookup is one batched query per run.
//
// prompt_version is threaded in from the caller rather than imported: the prompt
// constants live in eval.ts, which imports this module, and a value import back
// would be a runtime cycle.
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { isolated, sql } from "@/lib/db";
import { detached } from "@/lib/detached";
import { costLlm } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import { insertQuestionWithLabel, type ChunkWithQuestions } from "@/lib/rag/evalStore";
import { normalizeQuestion, selectNewQuestions } from "@/lib/rag/questionCacheCore";
import type { GeneratedQuestionPayload } from "@/lib/rag/eval";

// Same convention as embedCache.hashText: sha256 hex over the exact UTF-8 text.
const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Exported so the batch path can carry a 64-char hash on its persisted job input
// instead of every chunk's full text, and bank from it when the results land.
export const hashChunkText = hashText;

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

export type CachedQuestion = {
  difficulty: string;
  slot: number;
  question: string;
  expectedAnswer: string | null;
  inputTokens: number;
  outputTokens: number;
};

// Batched read for a whole run: everything banked for these passages, keyed by
// text hash, difficulties then slots ascending.
//
// DIFFICULTY IS A RESULT HERE, NOT A FILTER. "Add cached" asks "what do we
// already own for this passage?", so a chunk is offered the hard question an
// earlier config paid for even if this run never mentioned hard questions —
// a banked question is free, and declining it on a difficulty technicality just
// leaves money on the table. Row counts per passage are tiny, so reading them
// all costs nothing.
async function readBanked(
  model: string,
  promptVersion: string,
  hashes: string[],
): Promise<Map<string, CachedQuestion[]>> {
  const out = new Map<string, CachedQuestion[]>();
  if (hashes.length === 0) return out;
  try {
    const rows = await sql<
      {
        text_hash: string;
        difficulty: string;
        slot: number;
        question: string;
        expected_answer: string | null;
        input_tokens: number;
        output_tokens: number;
      }[]
    >`
      select text_hash, difficulty, slot, question, expected_answer,
             input_tokens, output_tokens
      from question_cache
      where user_id = ${activeUserId()}
        and llm_model = ${model}
        and prompt_version = ${promptVersion}
        and text_hash = any(${[...new Set(hashes)]})
      order by difficulty, slot
    `;
    for (const r of rows) {
      const list = out.get(r.text_hash) ?? [];
      list.push({
        difficulty: r.difficulty,
        slot: r.slot,
        question: r.question,
        expectedAnswer: r.expected_answer,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      });
      out.set(r.text_hash, list);
    }
    return out;
  } catch (err) {
    // Missing table -> behave as a cold cache. Anything else must surface: a
    // read that silently misses is a run that quietly added nothing.
    if (isMissingTable(err)) return out;
    throw err;
  }
}

// Give every chunk in scope whatever the bank holds for its exact text — the
// engine behind "Add cached". Nothing is generated and nothing is batched.
//
// DEDUPE IS BY QUESTION TEXT, against every question the chunk already shows under
// this config — generated, previously reused, or hand written. So pressing the
// button twice adds nothing the second time.
//
// Reused questions are inserted exactly as generated ones are and handed to
// `onLanded` so the caller can stream them into the dashboard live,
// indistinguishable from bought ones. `onTotal` fires once the additions are
// known, because until the bank has been read there is no honest number to size a
// progress bar with.
export async function fillChunksFromCache(
  chunks: ChunkWithQuestions[],
  model: string,
  promptVersion: string,
  onLanded: (question: GeneratedQuestionPayload) => void = () => {},
  onTotal: (total: number) => void = () => {},
): Promise<{ reused: number; difficulties: string[] }> {
  if (chunks.length === 0) {
    onTotal(0);
    return { reused: 0, difficulties: [] };
  }

  const hashes = chunks.map((c) => hashText(c.text));
  const banked = await readBanked(model, promptVersion, hashes);

  // Resolve every chunk's additions BEFORE inserting any, so the bar gets a real
  // total instead of counting up towards an unknown ceiling. Two chunks sharing a
  // text hash (repeated boilerplate) each take the full set: they are separate
  // chunks needing their own labels, and the dedupe is per chunk.
  const plan = chunks.map((chunk, i) => ({
    chunk,
    additions: selectNewQuestions(banked.get(hashes[i]) ?? [], chunk.existingQuestions),
  }));
  const total = plan.reduce((sum, p) => sum + p.additions.length, 0);
  onTotal(total);
  if (total === 0) return { reused: 0, difficulties: [] };

  let reused = 0;
  let savedUsd = 0;
  let savedTokens = 0;
  // What landed, so the caller can fold these difficulties into the config's mix
  // -- the questions are on the page now, and the mix should say so.
  const difficulties = new Set<string>();

  for (const { chunk, additions } of plan) {
    for (const hit of additions) {
      const questionId = await insertQuestionWithLabel({
        documentId: chunk.documentId,
        documentEmbeddingId: chunk.documentEmbeddingId,
        sourceChunkId: chunk.chunkId,
        question: hit.question,
        expectedAnswer: hit.expectedAnswer,
        generatorModel: model,
        difficulty: hit.difficulty,
      });
      reused += 1;
      difficulties.add(hit.difficulty);
      savedUsd += costLlm(model, hit.inputTokens, hit.outputTokens);
      savedTokens += hit.inputTokens + hit.outputTokens;
      onLanded({
        questionId,
        question: hit.question,
        difficulty: hit.difficulty,
        documentId: chunk.documentId,
        fileName: chunk.fileName,
        sourceChunkId: chunk.chunkId,
        expectedPosition: chunk.position,
      });
    }
  }

  console.log(`[rag:questionCache] reused ${reused} question(s), saving $${savedUsd.toFixed(6)}`);
  await detached(() => recordSaving("question_reuse", savedUsd, savedTokens, { events: reused }));
  return { reused, difficulties: [...difficulties] };
}

// Unbank one question: drop every row for this exact wording on this exact
// passage, so deleting it from the golden set also stops "Add cached" handing it
// back.
//
// DELIBERATELY NOT FILTERED BY MODEL OR DIFFICULTY. The same wording banked under
// another model would still return via "Add cached", and the intent when ticking
// the box is "stop showing me this question".
//
// Equality is `normalizeQuestion` — the same tested function that decides reuse in
// selectNewQuestions — applied in JS rather than as SQL `lower(btrim(...))`, which
// would be a second definition of equality free to drift from the first.
//
// Best-effort: the question is already deleted, and a failed uncache must not 500 a
// successful delete. The caller still gets the count (or null on failure) so the UI
// can say what actually happened.
export async function uncacheQuestion(
  chunkText: string,
  question: string,
): Promise<number | null> {
  const target = question.trim();
  if (target === "") return 0;
  try {
    const rows = await sql<{ id: string; question: string }[]>`
      select id, question
      from question_cache
      where user_id = ${activeUserId()}
        and text_hash = ${hashText(chunkText)}
    `;
    const key = normalizeQuestion(target);
    const ids = rows.filter((r) => normalizeQuestion(r.question) === key).map((r) => r.id);
    if (ids.length === 0) return 0;
    await sql`
      delete from question_cache
      where user_id = ${activeUserId()}
        and id = any(${ids}::uuid[])
    `;
    return ids.length;
  } catch (err) {
    if (isMissingTable(err)) return 0; // no bank, nothing to unbank
    console.warn(
      `[rag:questionCache] uncache failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// How many slots are already banked per passage, for a batch of keys at once.
//
// The batch apply path needs this: its results arrive long after build, with no
// per-gap slot offset to carry forward, and asking per question would be one
// query per result. One grouped count instead, keyed `${text_hash} ${difficulty}`.
const slotKey = (textHash: string, difficulty: string) => `${textHash} ${difficulty}`;

export async function bankedSlotCounts(
  model: string,
  promptVersion: string,
  keys: { textHash: string; difficulty: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  const hashes = [...new Set(keys.map((k) => k.textHash))];
  const difficulties = [...new Set(keys.map((k) => k.difficulty))];
  try {
    const rows = await sql<{ text_hash: string; difficulty: string; n: number }[]>`
      select text_hash, difficulty, count(*)::int as n
      from question_cache
      where user_id = ${activeUserId()}
        and llm_model = ${model}
        and prompt_version = ${promptVersion}
        and text_hash = any(${hashes})
        and difficulty = any(${difficulties})
      group by text_hash, difficulty
    `;
    for (const r of rows) out.set(slotKey(r.text_hash, r.difficulty), r.n);
    return out;
  } catch (err) {
    // Best-effort: a failed count means slots start at 0 and the insert's
    // `on conflict do nothing` drops what already exists. Banking is not worth
    // failing an apply that already paid for its results.
    if (!isMissingTable(err)) {
      console.warn(
        `[rag:questionCache] slot count failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return out;
  }
}

// Bank freshly generated questions for a passage.
//
// `startSlot` is where this chunk's questions begin — the count it already held at
// this difficulty — so slots stay dense and a later config asking for more picks
// up where this one stopped.
//
// Usage is the generating call's real input/output tokens divided by the number of
// questions it produced. Zero when the provider returned no usage, which banks the
// question and no dollars.
export async function bankQuestions(args: {
  textHash: string;
  difficulty: string;
  model: string;
  promptVersion: string;
  startSlot: number;
  questions: { question: string; expectedAnswer: string | null }[];
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const { questions, textHash } = args;
  if (questions.length === 0) return;
  const perIn = Math.round(args.inputTokens / questions.length);
  const perOut = Math.round(args.outputTokens / questions.length);
  const rows = questions.map((q, i) => ({
    user_id: activeUserId(),
    llm_model: args.model,
    difficulty: args.difficulty,
    text_hash: textHash,
    prompt_version: args.promptVersion,
    slot: args.startSlot + i,
    question: q.question,
    expected_answer: q.expectedAnswer,
    input_tokens: perIn,
    output_tokens: perOut,
  }));
  try {
    await isolated(
      () => sql`
        insert into question_cache ${sql(
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
      `,
    );
  } catch (err) {
    // Best-effort by nature: a missed row costs one future generation. It must
    // never fail the run that just PAID for these questions.
    console.warn(
      `[rag:questionCache] could not bank ${rows.length} question(s): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
