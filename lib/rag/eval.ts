// EVAL ENGINE: synthetic Recall@k for retrieval.
//
// For each chunk we ask the LLM to author a natural question the chunk answers
// (the chunk is the ground-truth label). Scoring is pure retrieval — embed the
// question, vector-search, check whether the labeled chunk is in the top-k. No
// LLM runs at scoring time.
//
// Known limitations, by design:
//   - Strict chunk-id match undercounts when overlapping chunks legitimately
//     answer the same question — a recall floor, not a bug.
//   - Synthetic questions skew easier than real user queries, so recall is an
//     optimistic estimate.
//   - Retrieval searches the whole model+dim chunks table (all docs/configs that
//     share it).
import type { StreamErrorEvent } from "@/lib/http/missingKey";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  addDifficulty,
  effectiveK,
  getActiveCriteria,
  retrievalDepth,
} from "@/lib/rag/evalSettingsStore";
import {
  listTrialModelOptions,
  modelSpec,
  sameVectorSpace,
  unavailableReason,
  type TrialModelOption,
} from "@/lib/rag/embeddingModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import {
  clearRetrievalChanges,
  listOverrides,
  overrideEmbeddings,
  retrievalStateFingerprint,
  setChunkOverride,
  setChunkOverridePieces,
  type ChunkOverride,
  type OverrideEmbedding,
} from "@/lib/rag/overrideStore";
import type Anthropic from "@anthropic-ai/sdk";
import { meteredMessage } from "@/lib/rag/meter";
import { fingerprintFrom } from "@/lib/rag/semanticCacheCore";
import {
  bankQuestions,
  bankedSlotCounts,
  fillChunksFromCache,
  hashChunkText,
} from "@/lib/rag/questionCache";
import { splitText, tokenizeWithOffsets } from "@/lib/rag/chunker";
import {
  cachedQueryVectors,
  cosine,
  embedDocsCached,
  embedQueryCached,
  meterEmbeds,
} from "@/lib/rag/embedCache";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { embedQuery } from "@/lib/rag/embeddings";
import { screenStoredResult, type ChangedChunkSims } from "@/lib/rag/dirtyScreen";
import { stitchChunks } from "@/lib/rag/reconstruct";
import {
  buildRetrievalContext,
  fuseWithOverrides,
  retrieveWithCutoffs,
} from "@/lib/rag/retriever";
import { chunkEmbeddings } from "@/lib/rag/vectorStore";
import {
  allLabeledQuestions,
  chunksNeedingQuestionsByDifficulty,
  chunksWithQuestions,
  createRunSnapshot,
  getCachedQueryEmbeddings,
  getChunkForGeneration,
  getChunksByIds,
  getChunkWindow,
  getCorpusChunkList,
  getExperimentContext,
  getModelTrialChunk,
  getModelTrialQuestions,
  getQuestionToScore,
  getSummary,
  insertModelTrial,
  insertQuestionWithLabel,
  insertResults,
  labelsWithBaseline,
  latestResultsForScreening,
  listModelTrials,
  putCachedQueryEmbedding,
  questionsNeedingScoring,
  rankWithSubstitutedChunk,
  restampLatestResults,
  type CorpusChunkListItem,
  type ExperimentContext,
  type PoolChunk,
  type QuestionToScore,
  type ResultInsert,
  type SavedModelTrial,
  type TrialKind,
  type TrialPoolHit,
  type TrialQuestionOutcome,
} from "@/lib/rag/evalStore";

// Progress events streamed to the client during a process/rescore run. The
// routes serialize these as NDJSON; the dashboard appends new questions and
// flips badges live as each generation/result lands.

// A freshly generated question, shipped on the generate-progress event so the
// dashboard can append its row (unscored) without waiting for the end-of-run
// reload. Carries the chunk-group header bits (fileName/position) since the
// chunk may not have any questions on screen yet.
export type GeneratedQuestionPayload = {
  questionId: string;
  question: string;
  difficulty: string | null;
  documentId: string;
  fileName: string;
  sourceChunkId: string;
  expectedPosition: number | null;
};

export type EvalEvent =
  | { type: "generate-start"; total: number }
  // `question` is absent when the step produced nothing (truncation/refusal).
  | {
      type: "generate-progress";
      done: number;
      total: number;
      question?: GeneratedQuestionPayload;
    }
  | { type: "score-start"; total: number }
  | {
      type: "score-result";
      done: number;
      total: number;
      questionId: string;
      hit: boolean;
      foundRank: number | null;
    }
  // Bulk nDCG grading: one aggregate ranking built + promoted per question.
  // `ok: false` carries the per-question failure so one bad question doesn't abort
  // the run.
  //
  // The bulk LLM pass reuses both events and reports what it decided NOT to spend
  // on up front: `total` is only the questions that will actually hit the LLM, and
  // the two skip counts explain the rest.
  | {
      type: "ranking-start";
      total: number;
      skippedNoAggregate?: number;
      skippedCached?: number;
    }
  | {
      type: "ranking-progress";
      done: number;
      total: number;
      questionId: string;
      ok: boolean;
      error?: string;
    }
  // The run's id, first line of every stream — what POST /api/eval/cancel needs
  // to reach it. Emitted by ndjsonStream itself, not by any of the jobs below.
  | { type: "run-started"; runId: string }
  | {
      type: "done";
      // The run stopped early because the user cancelled it. The counts are the
      // REAL ones: partial work is committed, never rolled back (the whole run
      // is one transaction — see lib/http/cancelRegistry.ts).
      cancelled?: boolean;
      generated: number;
      // Questions served from question_cache instead of generated — free. Only
      // the "Add cached" run produces these; every other path leaves it absent.
      reused?: number;
      scored: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
      // Bulk nDCG grading only: questions that got a new ground-truth ranking.
      graded?: number;
      // Bulk LLM nDCG only: llm_rerank rankings built (comparison candidates —
      // nothing was promoted to ground truth), plus the two skip tallies so the
      // dashboard's summary line can explain the questions we didn't spend on.
      llmRanked?: number;
      skippedNoAggregate?: number;
      skippedCached?: number;
    }
  // Emitted instead of the inline generate/score events when the config's
  // Savings preference routes question generation through the batch API: the
  // work was submitted, not run here — track it in the Batches panel.
  | { type: "batch-submitted"; jobId: string; requestCount: number }
  // The shared stream error shape — carries the missing-provider-key fields
  // when that was the cause, so every stream reports it the same way the
  // plain routes do. See lib/http/missingKey.ts.
  | StreamErrorEvent;

type Emit = (event: EvalEvent) => void;

// Cancellation, as a flag the loops below poll between units of work. It is NEVER
// thrown: the run is one transaction that commits when the stream ends, so
// unwinding out of a loop would discard every question already generated and
// banked with the tokens already paid for. Loops break and return normally, and
// `done` reports the real counts with `cancelled: true`. A cancelled generation
// therefore leaves its questions unscored — "Score pending" finishes them later.

// On-demand synthetic questions can target a difficulty — a dial on how far the
// question's wording drifts from the passage's surface form. Higher difficulty
// means less lexical overlap, so retrieval is stress-tested with harder queries.
export type Difficulty = "easy" | "medium" | "hard";

// Per-difficulty steer, appended to the (per-chunk, uncached) user turn so the
// static system prompt below stays a cache-stable prefix. Every level keeps the
// answer uniquely grounded in this passage — otherwise a too-obscure "hard"
// question could be better answered by another chunk and unfairly tank recall.
function difficultyInstruction(difficulty: Difficulty): string {
  switch (difficulty) {
    case "easy":
      return (
        "Difficulty: EASY. Ask a direct, factual question. You may reuse the " +
        "passage's key terms and nouns; the answer should be obvious to anyone " +
        "who has read it."
      );
    case "medium":
      return (
        "Difficulty: MEDIUM. Rephrase entirely in your own words — avoid the " +
        "passage's distinctive phrasing and prefer synonyms — but keep it a " +
        "natural, direct question."
      );
    case "hard":
      return (
        "Difficulty: HARD. Ask indirectly or from a higher level of abstraction " +
        '(e.g. an applied, "how would I…", or downstream-consequence angle). ' +
        "Share no distinctive vocabulary with the passage and require the reader " +
        "to connect concepts. The answer MUST still be found uniquely and " +
        "completely within this passage — never answerable from general " +
        "knowledge or from a different passage."
      );
  }
}

// Static across every chunk, so it can sit in a cached prefix. Kept deliberately
// strict about NOT quoting the passage — verbatim questions make retrieval
// trivial and inflate recall.
const GENERATION_SYSTEM =
  "You write evaluation questions for a retrieval system. Given a passage from " +
  "a document, write natural questions that a user might ask whose answer is " +
  "found in THAT passage. Rules: (1) Write the question as a real user would " +
  "phrase it — do NOT quote or closely paraphrase the passage's wording, since " +
  "that makes retrieval trivially easy. (2) Each question must be answerable " +
  "from the passage alone. (3) Keep questions self-contained (no 'this passage' " +
  "or 'the text above'). Also provide a short expected_answer drawn from the " +
  "passage for each question.";

// JSON-schema-constrained output so we never have to defensively parse prose.
const QUESTIONS_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            expected_answer: { type: "string" },
          },
          required: ["question", "expected_answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

type GeneratedQuestion = { question: string; expected_answer: string };

// Identifies the INSTRUCTIONS a cached question was written to, so question_cache
// can never serve one authored under different wording. Derived from the prompt
// constants themselves rather than a hand-bumped literal: edit any of them and
// the fingerprint changes, the cache misses, and the questions are regenerated.
//
// `count` is deliberately absent. It changes the rendered user turn but not what
// a question for slot i of a passage IS, and excluding it is what lets the inline
// path (N per call) and the batch path (one per request) share banked rows.
export const QUESTION_PROMPT_VERSION = fingerprintFrom([
  "qg-v1",
  GENERATION_SYSTEM,
  difficultyInstruction("easy"),
  difficultyInstruction("medium"),
  difficultyInstruction("hard"),
  JSON.stringify(QUESTIONS_FORMAT),
]);

// The Anthropic request params for authoring `count` question(s) from one
// passage — factored out so the inline path (authorQuestions) and the batch path
// (lib/batch/jobs/questionGeneration) build the SAME prompt. `model` is passed
// in (the caller's activeConfig().llmModel) so this stays scope-free and can run
// when a batch is applied later, outside the original request.
export function questionRequestParams(
  text: string,
  count: number,
  difficulty: Difficulty | undefined,
  model: string,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  // The difficulty steer (when set) leads the user turn; the passage follows.
  const steer = difficulty ? `${difficultyInstruction(difficulty)}\n\n` : "";
  return {
    model,
    // Scale headroom with the ask so a larger target can't truncate the JSON.
    max_tokens: Math.min(1024 + (count - 1) * 512, 4096),
    thinking: { type: "disabled" },
    output_config: { format: QUESTIONS_FORMAT },
    system: [
      {
        type: "text",
        text: GENERATION_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `${steer}Write exactly ${count} question(s) for this passage:\n\n${text}`,
      },
    ],
  };
}

// Parse a generation response — an inline Message OR a batch result's message
// body — into up to `count` questions. Structured outputs guarantee schema-valid
// JSON on a clean stop, but a truncation (max_tokens) or refusal can still yield
// unparseable text: skip that chunk (it stays under target, retried next pass).
export function parseQuestions(
  message: { content: Array<{ type: string; text?: string }>; stop_reason?: string | null },
  count: number,
): GeneratedQuestion[] {
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") return [];
  try {
    const parsed = JSON.parse(textBlock.text) as { questions?: GeneratedQuestion[] };
    return (parsed.questions ?? []).slice(0, count);
  } catch {
    console.warn(
      `[rag:eval] could not parse generated questions (stop_reason=${message.stop_reason ?? "?"}); skipping chunk`,
    );
    return [];
  }
}

// Returns the parsed questions alongside the call's real token usage, which the
// question cache banks so a later reuse can be priced from what the work actually
// cost rather than from a char/4 estimate of the question text.
async function authorQuestions(
  text: string,
  count: number,
  difficulty?: Difficulty,
): Promise<{ questions: GeneratedQuestion[]; inputTokens: number; outputTokens: number }> {
  const response = await meteredMessage(
    "question_gen",
    questionRequestParams(text, count, difficulty, activeConfig().llmModel),
  );
  return {
    questions: parseQuestions(response, count),
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

// How many questions a bulk run wants per chunk at one difficulty. Bulk actions
// → Add question lets the user click a difficulty several times; each click is
// one more question per chunk, so {difficulty:'easy', count:2} adds two easy
// questions to every chunk — or, with Top up ticked, tops every chunk up TO two.
export type DifficultyTarget = { difficulty: Difficulty; count: number };

// Generate `count` question(s) per SELECTED difficulty for every chunk in scope —
// or, with `topUp`, only for chunks short of that target and only the shortfall.
// Each question slot is its own progress step so the bar reflects the real work;
// a chunk needing several at one difficulty asks the model for them in ONE call,
// which keeps them from coming back near-identical.
export async function generateMissingQuestions(
  targets: DifficultyTarget[],
  emit: Emit = () => {},
  documentIds?: string[],
  topUp = false,
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<number> {
  if (targets.length === 0) return 0;
  const gaps = await chunksNeedingQuestionsByDifficulty(
    targets.map((t) => t.difficulty),
    documentIds,
    targets.map((t) => t.count),
    topUp,
  );
  if (gaps.length === 0) return 0;

  // Progress is per question, not per gap: a gap needing 3 counts as 3 steps.
  const total = gaps.reduce((sum, g) => sum + g.needed, 0);
  const model = activeConfig().llmModel;
  console.log(
    `[rag:eval] generating ${total} question(s) across difficulties ` +
      `[${targets.map((t) => `${t.difficulty}×${t.count}`).join(", ")}]`,
  );
  emit({ type: "generate-start", total });

  let generated = 0;
  let done = 0;

  // Where each passage's banked questions continue from, so what this run buys
  // is banked ABOVE what another config already banked for the same text rather
  // than colliding with it (the insert's `on conflict do nothing` would silently
  // drop the collision). One grouped count for the whole run.
  const hashes = gaps.map((g) => hashChunkText(g.text));
  const banked0 = await bankedSlotCounts(
    model,
    QUESTION_PROMPT_VERSION,
    gaps.map((g, i) => ({ textHash: hashes[i], difficulty: g.difficulty })),
  );
  // Slots this run has already banked per passage, so two gaps sharing a text
  // hash (repeated boilerplate) stack instead of overwriting each other.
  const bankedHere = new Map<string, number>();

  for (const [gi, gap] of gaps.entries()) {
    // Checkpoint: between gaps, i.e. between paid model calls. Breaking here
    // keeps every question generated (and banked) so far — see the note on
    // ShouldStop above.
    if (shouldStop()) {
      console.log(`[rag:eval] cancelled after ${generated} question(s)`);
      break;
    }
    const authored = await authorQuestions(
      gap.text,
      gap.needed,
      gap.difficulty as Difficulty,
    );
    // One step per slot the gap asked for — a model that returned fewer (or
    // unparseable) questions still advances the bar; the chunk stays under
    // target and is retried on the next pass.
    const banked: { question: string; expectedAnswer: string | null }[] = [];
    for (let i = 0; i < gap.needed; i += 1) {
      const q = authored.questions[i];
      let landed: GeneratedQuestionPayload | undefined;
      if (q && q.question.trim()) {
        const question = q.question.trim();
        const expectedAnswer = q.expected_answer?.trim() || null;
        const questionId = await insertQuestionWithLabel({
          documentId: gap.documentId,
          documentEmbeddingId: gap.documentEmbeddingId,
          sourceChunkId: gap.chunkId,
          question,
          expectedAnswer,
          generatorModel: model,
          difficulty: gap.difficulty,
        });
        generated += 1;
        banked.push({ question, expectedAnswer });
        landed = {
          questionId,
          question,
          difficulty: gap.difficulty,
          documentId: gap.documentId,
          fileName: gap.fileName,
          sourceChunkId: gap.chunkId,
          expectedPosition: gap.position,
        };
      }
      done += 1;
      emit({ type: "generate-progress", done, total, question: landed });
    }
    // Bank what we just paid for. Always — banking is unconditional; only
    // SERVING is a deliberate act ("Add cached questions" in Bulk actions), and
    // it needs data to hit against.
    const bankKey = `${hashes[gi]} ${gap.difficulty}`;
    const startSlot = (banked0.get(bankKey) ?? 0) + (bankedHere.get(bankKey) ?? 0);
    await bankQuestions({
      textHash: hashes[gi],
      difficulty: gap.difficulty,
      model,
      promptVersion: QUESTION_PROMPT_VERSION,
      startSlot,
      questions: banked,
      inputTokens: authored.inputTokens,
      outputTokens: authored.outputTokens,
    });
    bankedHere.set(bankKey, (bankedHere.get(bankKey) ?? 0) + banked.length);
  }

  console.log(`[rag:eval] generated ${generated} question(s)`);
  return generated;
}

// Author one synthetic question for a single chunk at the requested difficulty
// and persist it (source 'generated', unscored until the next run) — the
// on-demand counterpart to the bulk generator above. Returns "not-found" when
// the chunk isn't part of the active config, "empty" when the model returned no
// usable question (truncation/refusal), else "ok".
export async function generateQuestionForChunk(
  chunkId: string,
  difficulty: Difficulty,
): Promise<"ok" | "not-found" | "empty"> {
  const chunk = await getChunkForGeneration(chunkId);
  if (!chunk) return "not-found";
  const model = activeConfig().llmModel;

  const authored = await authorQuestions(chunk.text, 1, difficulty);
  const [q] = authored.questions;
  if (!q || !q.question.trim()) return "empty";

  const question = q.question.trim();
  const expectedAnswer = q.expected_answer?.trim() || null;
  await insertQuestionWithLabel({
    documentId: chunk.documentId,
    documentEmbeddingId: chunk.documentEmbeddingId,
    sourceChunkId: chunkId,
    question,
    expectedAnswer,
    generatorModel: model,
    difficulty,
  });
  // Banked above whatever this passage already holds, so the row lands instead
  // of colliding with an existing slot and being dropped.
  const textHash = hashChunkText(chunk.text);
  const banked = await bankedSlotCounts(model, QUESTION_PROMPT_VERSION, [
    { textHash, difficulty },
  ]);
  await bankQuestions({
    textHash,
    difficulty,
    model,
    promptVersion: QUESTION_PROMPT_VERSION,
    startSlot: banked.get(`${textHash} ${difficulty}`) ?? 0,
    questions: [{ question, expectedAnswer }],
    inputTokens: authored.inputTokens,
    outputTokens: authored.outputTokens,
  });
  return "ok";
}

// Embed each question, vector-search, and record whether its labeled chunk landed
// in the top-k. Pure retrieval — no LLM at scoring time. Shared by the incremental
// and full scoring paths.
//
// A question's query vector depends only on (text, model), so we reuse cached
// vectors and embed only misses. On a warm cache each iteration is just a fast
// vector search — the win that makes repeat "Re-score all" runs cheap.
//
// The override state is loaded ONCE for the batch: it can't change mid-run, and
// re-reading the override rows + every model's pieces per question was the
// dominant repeat cost under override configs. A few questions score
// concurrently; every shared cache upserts idempotently, so races cost at most a
// duplicate embed of the same text.
// Tried at 8 (2026-08-03) on the theory that scoring is latency-bound and the
// pool has 10 connections. Measured: no effect — rescore 44.5s → 45.4s, confirm
// 82.3s → 81.4s. Reverted. Whatever bounds a batch here, it is not pool width;
// don't re-raise it without finding out what actually is.
const SCORE_CONCURRENCY = 4;

export async function scoreQuestions(
  questions: QuestionToScore[],
  emit: Emit = () => {},
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<number> {
  if (questions.length === 0) return 0;

  emit({ type: "score-start", total: questions.length });

  const cfg = activeConfig();
  // Retrieve a superset deep enough for every enabled metric, then judge recall at
  // recall_k. These four reads are the batch's fixed setup and have no data
  // dependency on each other — one round trip instead of four, measured at ~129ms
  // each. "Once per batch" is only cheap when the batch is big: autotune scores one
  // question per call, so it re-pays all of it per question.
  //
  // Every result is stamped with the override state it's scored under (0022) — the
  // state can't change mid-run, so one fingerprint covers the batch. The same
  // promise is handed to buildRetrievalContext as its piece-cache key, so the
  // fingerprint is still fetched in parallel here rather than ahead of it.
  const statePromise = retrievalStateFingerprint();
  const [criteria, cached, retrievalState, ctx] = await Promise.all([
      getActiveCriteria(),
      getCachedQueryEmbeddings(
        questions.map((q) => q.questionId),
        cfg.embeddingModel,
      ),
    statePromise,
    buildRetrievalContext(statePromise),
  ]);
  const depth = retrievalDepth(criteria, cfg.topK);
  const recallK = effectiveK(criteria.recall, cfg.topK);

  // BASELINE LEG (0057). When the config carries overrides, each question also gets
  // a shadow measurement with none in effect — the "what has my tuning bought?"
  // side of the dashboard ticker.
  //
  // Skipped entirely when the config has NO overrides: the live row already IS the
  // baseline. Skipped per question when one exists at the current baseline_key, so
  // re-scores don't re-measure a baseline that cannot have moved.
  //
  // It costs one extra vector query and ZERO dollars: `{ ...ctx, overrides: [] }`
  // takes retrieveWithCutoffs' single-ANN fast path against the same cached query
  // vector — no fusion pool, no re-embedding, no provider call.
  const baselineCtx = ctx.overrides.length > 0 ? { ...ctx, overrides: [] } : null;
  const haveBaseline = baselineCtx
    ? await labelsWithBaseline(questions.map((q) => q.labelId))
    : new Set<string>();

  const results: ResultInsert[] = new Array<ResultInsert>(questions.length);
  const baselineResults: ResultInsert[] = new Array<ResultInsert>(questions.length);
  let done = 0;
  let nextIndex = 0;
  // Cost accounting for the query-vector cache (eval_question_embeddings). It's
  // a PAID path — the no-cache counterfactual re-embeds every question on every
  // re-score — so hits are avoided embeds and misses are real spend, priced the
  // same way embedCache prices its own. Tallied across the batch and metered
  // once below (one upsert, not one per question).
  const qHits: string[] = [];
  const qMisses: string[] = [];
  const worker = async () => {
    for (let i = nextIndex++; i < questions.length; i = nextIndex++) {
      // Checkpoint: between questions, in every worker. Each worker just stops
      // claiming indices, so the ones already in flight finish and their results
      // are inserted below with the rest.
      if (shouldStop()) break;
      const q = questions[i];
      let vector = cached.get(q.questionId);
      if (vector) {
        qHits.push(q.question);
      } else {
        vector = await embedQuery(q.question);
        qMisses.push(q.question);
        await putCachedQueryEmbedding(q.questionId, cfg.embeddingModel, vector);
      }
      // Pass the question text too: override configs embed it under the override
      // models for the rank-interleave fusion; non-override configs ignore it (base vector only).
      const { retrieved, cutoffs } = await retrieveWithCutoffs(q.question, vector!, depth, ctx);
      const ids = retrieved.map((r) => r.chunk.chunk.id);
      const scores = retrieved.map((r) => r.score);
      const rank = ids.indexOf(q.sourceChunkId);
      const foundRank = rank === -1 ? null : rank + 1;
      // Hit = the ground truth landed within recall_k of the retrieved superset.
      const hit = foundRank !== null && foundRank <= recallK;
      results[i] = {
        questionId: q.questionId,
        labelId: q.labelId,
        k: recallK,
        hit,
        foundRank,
        retrievedIds: ids,
        retrievedScores: scores,
        retrievalState,
        screenCutoffs: cutoffs,
      };
      if (baselineCtx && !haveBaseline.has(q.labelId)) {
        const base = await retrieveWithCutoffs(q.question, vector!, depth, baselineCtx);
        const baseIds = base.retrieved.map((r) => r.chunk.chunk.id);
        const baseIdx = baseIds.indexOf(q.sourceChunkId);
        const baseRank = baseIdx === -1 ? null : baseIdx + 1;
        baselineResults[i] = {
          questionId: q.questionId,
          labelId: q.labelId,
          k: recallK,
          hit: baseRank !== null && baseRank <= recallK,
          foundRank: baseRank,
          retrievedIds: baseIds,
          retrievedScores: base.retrieved.map((r) => r.score),
          // The honest fingerprint for an override-free retrieval — and what
          // makes these rows readable alongside the free historical ones.
          retrievalState: "baseline",
          screenCutoffs: base.cutoffs,
          isBaseline: true,
        };
      }
      done += 1;
      emit({
        type: "score-result",
        done,
        total: questions.length,
        questionId: q.questionId,
        hit,
        foundRank,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SCORE_CONCURRENCY, questions.length) }, worker),
  );
  await meterEmbeds(cfg.embeddingModel, qHits, qMisses);

  // A cancelled run leaves holes in the pre-sized array (the slots no worker
  // claimed), so insert what actually scored and report that count — not
  // questions.length, which would claim work nobody did.
  const landed = results.filter((r): r is ResultInsert => r !== undefined);
  // One insert for both legs: the baseline rows are the same shape and a
  // cancelled run leaves the same holes in their array.
  await insertResults([
    ...landed,
    ...baselineResults.filter((r): r is ResultInsert => r !== undefined),
  ]);
  // The count is LIVE results only — baseline rows are shadow measurements, and
  // reporting them would claim scoring work the user didn't ask for.
  return landed.length;
}

// Score ONE question on demand (embed → retrieve → persist a result) so its graded
// metrics populate immediately instead of waiting for a bulk run — used by the nDCG
// ranking panel once a question has a ground truth. No-op (returns false) when the
// question has no label under the active config.
export async function scoreQuestionNow(questionId: string): Promise<boolean> {
  const q = await getQuestionToScore(questionId);
  if (!q) return false;
  await scoreQuestions([q]);
  return true;
}

// Re-score ONE CHUNK's pending questions — the automatic follow-up to a
// delegate/override change: the changed chunk gets fresh rates immediately
// while every other chunk keeps its (now stale-badged) scores until the next
// full run. Draws from questionsNeedingScoring so a question already fresh
// (e.g. scored moments ago) isn't scored twice.
export async function rescoreChunkQuestions(chunkId: string): Promise<number> {
  const pending = (await questionsNeedingScoring()).filter(
    (q) => q.sourceChunkId === chunkId,
  );
  if (pending.length === 0) return 0;
  return scoreQuestions(pending);
}

// Score every question that has no fresh result (new or edited since last score).
export async function scoreUnscoredQuestions(
  emit: Emit = () => {},
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<number> {
  const pending = await questionsNeedingScoring();
  if (pending.length === 0) return 0;
  console.log(`[rag:eval] scoring ${pending.length} question(s) @ k=${activeConfig().topK}`);
  return scoreQuestions(pending, emit, shouldStop);
}

// The "Score pending" button: score every question with no fresh result — new,
// edited, or retrieval-stale — then freeze a comparison snapshot. It GENERATES
// NOTHING: buying questions is Bulk actions → Add, which is also the only
// generation path that can route through the batch API. This is the cheap
// incremental complement to "Re-score all", and what finishes a cancelled
// generation's unscored leftovers.
export async function scorePendingQuestions(
  emit: Emit = () => {},
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<{
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const scored = await scoreUnscoredQuestions(emit, shouldStop);
  const cancelled = shouldStop();
  // Everything pending (incl. retrieval-stale) is fresh now — the logged
  // override changes are baked into the rates, so the stale badge can drop.
  // Skipped on cancel: questions this run never reached are still stale, and
  // clearing the log would drop the badge that says so.
  if (!cancelled) await clearRetrievalChanges();

  const summary = await getSummary();
  // Only snapshot when something actually changed, so repeated clicks don't
  // pile up identical run rows.
  if (scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }

  console.log(
    `[rag:eval] scorePendingQuestions done: scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    // Nothing is generated here; the zero keeps the shared client event shape.
    type: "done",
    cancelled,
    generated: 0,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { scored, recall: summary.recall };
}

// "Bulk actions → Add question → {difficulty ×N} → Add": persist each requested
// difficulty into the config's mix, then add N questions at that difficulty to
// every chunk in scope (or, with `topUp`, top each chunk up TO N), score the
// unscored, and freeze a snapshot. Streams the same EvalEvents as the other runs
// so the dashboard reuses the same progress UI.
export async function bulkAddDifficulties(
  targets: DifficultyTarget[],
  emit: Emit = () => {},
  documentIds?: string[],
  topUp = false,
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<{ generated: number; scored: number; recall: number | null }> {
  for (const t of targets) await addDifficulty(t.difficulty);
  const generated = await generateMissingQuestions(
    targets,
    emit,
    documentIds,
    topUp,
    shouldStop,
  );
  // Cancelling the generation half skips the scoring half outright rather than
  // scoring the part that landed: the user asked the run to stop, and what it
  // generated is left pending for "Score pending".
  const scored = shouldStop() ? 0 : await scoreUnscoredQuestions(emit, shouldStop);

  const summary = await getSummary();
  if (generated > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }

  emit({
    type: "done",
    cancelled: shouldStop(),
    generated,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { generated, scored, recall: summary.recall };
}

// "Bulk actions → Add question → Add cached": the free counterpart to
// bulkAddDifficulties. Every chunk in scope is handed whatever the bank holds for
// its exact text — ANY difficulty, no target and no staged counts, since a banked
// question costs nothing. Nothing is generated and nothing is batched.
//
// Deliberate rather than automatic: reuse hands you wording authored under
// another config, which is what you want when comparing configs over one corpus
// and what you don't want when you asked for fresh questions.
//
// Duplicates are impossible by construction — fillChunksFromCache compares
// question TEXT against everything the chunk already shows.
export async function bulkAddCachedQuestions(
  emit: Emit = () => {},
  documentIds?: string[],
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<{ reused: number; scored: number; recall: number | null }> {
  const chunks = await chunksWithQuestions(documentIds);
  let total = 0;
  let done = 0;
  const { reused, difficulties } = await fillChunksFromCache(
    chunks,
    activeConfig().llmModel,
    QUESTION_PROMPT_VERSION,
    (question) => {
      done += 1;
      emit({ type: "generate-progress", done, total, question });
    },
    // The bar can only be sized once the bank has been read, so it opens here
    // rather than before the query — and at 0 when nothing matched, which the
    // dashboard renders as a run that finished without adding anything.
    (n) => {
      total = n;
      emit({ type: "generate-start", total });
    },
  );
  // Reflect what actually landed in the config's mix — a record of which
  // difficulties this config has used, which is what eval_difficulties is now
  // that nothing auto-generates from it.
  for (const d of difficulties) await addDifficulty(d as Difficulty);
  // The fill itself is one free query — the cancellable half is the scoring
  // that follows it, which is where this run's time actually goes.
  const scored = shouldStop() ? 0 : await scoreUnscoredQuestions(emit, shouldStop);

  const summary = await getSummary();
  if (reused > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }

  console.log(
    `[rag:eval] bulkAddCachedQuestions: reused=${reused} across ${chunks.length} chunk(s)`,
  );
  emit({
    type: "done",
    cancelled: shouldStop(),
    generated: 0,
    reused,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { reused, scored, recall: summary.recall };
}

// "Re-score all" MOVED to lib/jobs/steps/rescore.ts, where it is expressed as a
// resumable step so the same implementation can run streamed (the button) or
// sliced across invocations (a background job). The route drives it through
// lib/jobs/stream.ts. Nothing here imports it back: the dependency runs jobs → rag
// in one direction only.

// DIRTY-SET RE-SCORE — autotune's replacement for the final full re-score.
//
// An autotune run only changes the representation of the chunks it overrode; every
// other chunk's vectors are untouched. Per question, the pure screen in
// dirtyScreen.ts decides from the stored 0028 cutoffs and a couple of cached-vector
// cosines whether the run's changed chunks could have altered the stored result at
// all. Questions proven unaffected keep their stored rows, re-stamped with the
// final fingerprint; only the rest re-run real retrieval. Same end state as
// rescoreAllQuestions, minus the redundant retrievals.

// One chunk whose override state differs between an autotune run's start and
// end. `finalModel` = the override's model in the END state (null = override
// cleared); `startOverridden` = it had one (any kind) at run start.
export type ChangedChunk = {
  chunkId: string;
  finalModel: string | null;
  startOverridden: boolean;
};

// The screen's verdict over the whole corpus, and the input to both halves of the
// re-score that follows it.
//
// SPLIT FROM THE SCORING so autotune's tail can slice (docs/autotune-slicing-plan
// .md §3): at 470 questions the re-score is ~9 minutes on its own, which is more
// than one function invocation gets. Nothing here writes, so a slice may re-run it
// freely — and re-running is what makes the phase self-eliminating, since a
// question scored under `finalState` by an earlier slice drops out of `dirty` on
// the next one without any stored list of what is left.
export type AffectedScreen = {
  finalState: string;
  dirty: QuestionToScore[];
  // Questions the screen PROVED a re-retrieval could not have moved. They still
  // carry the old fingerprint until settleAffectedRescore re-stamps them, so they
  // stay in this list across slices rather than draining like `dirty` does.
  cleanLabelIds: string[];
  total: number;
};

export async function screenAffectedQuestions(
  changed: ChangedChunk[],
  startState: string,
): Promise<AffectedScreen> {
  const cfg = activeConfig();
  const criteria = await getActiveCriteria();
  const depth = retrievalDepth(criteria, cfg.topK);
  const finalState = await retrievalStateFingerprint();

  const questions = await allLabeledQuestions();
  const latest = await latestResultsForScreening(finalState);
  const qids = questions.map((q) => q.questionId);

  // Everything the screens compare is prefetched, batched, and CACHE-ONLY — a miss
  // marks the question dirty rather than paying a provider call (the re-score would
  // have to embed it anyway). Base-model query vectors live in
  // eval_question_embeddings (keyed by question id); override-model ones live in
  // embedding_cache (keyed by text), hence the two lookups.
  const baseQVecs = await getCachedQueryEmbeddings(qids, cfg.embeddingModel);
  const models = [...new Set(changed.flatMap((c) => (c.finalModel ? [c.finalModel] : [])))];
  const modelQVecs = new Map<string, Map<string, number[]>>(); // model → question TEXT → vec
  for (const m of models) {
    // Same-space models fold into the base lane (retriever.fuseWithOverrides),
    // so their pieces are scored against the BASE query vector — no model-space
    // query vectors are needed (or fetched) for them.
    if (!sameVectorSpace(m, cfg.embeddingModel)) {
      modelQVecs.set(m, await cachedQueryVectors(questions.map((q) => q.question), m));
    }
  }
  const piecesByChunk = new Map<string, number[][]>();
  for (const m of models) {
    const pieces = await overrideEmbeddings(m);
    for (const c of changed) {
      if (c.finalModel !== m) continue;
      piecesByChunk.set(
        c.chunkId,
        pieces.filter((p) => p.chunkId === c.chunkId).map((p) => p.embedding),
      );
    }
  }
  const chunkBaseVecs = await chunkEmbeddings(changed.map((c) => c.chunkId));

  // Per question: compute the two sims each changed chunk needs (null when a
  // vector isn't in any cache — the screen treats that as dirty) and let the
  // pure screen (dirtyScreen.ts) decide.
  const simsFor = (q: QuestionToScore): ChangedChunkSims[] => {
    const qBase = baseQVecs.get(q.questionId) ?? null;
    return changed.map((x) => {
      const xBase = chunkBaseVecs.get(x.chunkId) ?? null;
      const baseSim = qBase && xBase ? cosine(qBase, xBase) : null;
      let bestPieceSim: number | null = null;
      if (x.finalModel !== null) {
        // Match the retriever's query vector: same-space folds use the base
        // query vector, foreign spaces use the model-embedded one.
        const qv =
          sameVectorSpace(x.finalModel, cfg.embeddingModel)
            ? qBase
            : (modelQVecs.get(x.finalModel)?.get(q.question) ?? null);
        const pieces = piecesByChunk.get(x.chunkId);
        if (qv && pieces && pieces.length > 0) {
          bestPieceSim = pieces.reduce((best, p) => Math.max(best, cosine(qv, p)), -Infinity);
        }
      }
      return { ...x, baseSim, bestPieceSim };
    });
  };

  const dirty: QuestionToScore[] = [];
  const cleanLabelIds: string[] = [];
  for (const q of questions) {
    const r = latest.get(q.labelId);
    const editStale = !r || r.scoredAt === null || r.scoredAt < r.updatedAt;
    // Already scored under the final state (and not edited since) → fresh.
    if (r && r.retrievalState === finalState && !editStale) continue;
    const verdict = !r
      ? "dirty"
      : screenStoredResult({
          depth,
          baseModel: cfg.embeddingModel,
          startState,
          retrievalState: r.retrievalState,
          editStale,
          retrievedIds: r.retrievedIds,
          cutoffs: r.screenCutoffs,
          changed: simsFor(q),
        });
    if (verdict === "clean") cleanLabelIds.push(q.labelId);
    else dirty.push(q);
  }

  const skipped = questions.length - dirty.length;
  console.log(
    `[rag:eval] dirty-set re-score: ${dirty.length}/${questions.length} dirty ` +
      `(${cleanLabelIds.length} proven clean, ${skipped - cleanLabelIds.length} already fresh) ` +
      `across ${changed.length} changed chunk(s)`,
  );
  return { finalState, dirty, cleanLabelIds, total: questions.length };
}

// The tail, once nothing is dirty any more: stamp the proven-clean rows, drop the
// change log, freeze the snapshot. Separate from the scoring so it runs exactly
// once no matter how many slices the scoring took — and idempotent, because a
// slice that dies after committing its work will run it again.
export async function settleAffectedRescore(
  screen: AffectedScreen,
  startState: string,
): Promise<{ recall: number | null; mrr: number | null; ndcg: number | null }> {
  // Proven-clean rows carry results a real re-retrieval would reproduce —
  // only their fingerprint stamp changes.
  await restampLatestResults(screen.cleanLabelIds, startState, screen.finalState);
  // Every label is now fresh under finalState (re-scored, re-stamped, or
  // already fresh), so the change log can drop like after a full re-score.
  await clearRetrievalChanges();

  const summary = await getSummary();
  // Always snapshot (when there's anything to snapshot): autotune's history
  // and Appraise expect an eval_runs row at the end of every run, even one
  // whose final re-score proved everything clean.
  if (screen.total > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }
  console.log(
    `[rag:eval] dirty-set re-score settled: recall=${summary.recall ?? "n/a"} ` +
      `over ${screen.total} question(s)`,
  );
  return { recall: summary.recall, mrr: summary.mrr, ndcg: summary.ndcg };
}

// Re-chunk experiment: an ephemeral per-chunk "what-if" (autotune Stage 1).
//
// Re-split ONE labeled chunk at a trial (size, overlap), embed the pieces, and
// re-rank the question against a corpus where that chunk is replaced by its
// sub-chunks. Nothing is persisted, so live retrieval and every other question's
// score are untouched.
//
// This is a LOCAL APPROXIMATION of a full re-chunk: the chunk's document neighbors
// stay frozen, so the seams between this chunk and its neighbors are not re-formed.
// Size is the high-signal knob; read overlap results with that caveat. Ranking is
// an exact full-scan against the substituted corpus — no pool approximation.

// One sub-chunk's standing in the experiment ranking.
export type RechunkSubChunk = {
  subIndex: number; // 0-based piece order within the original chunk
  rank: number; // 1-based exact rank in the substituted corpus
  score: number; // cosine similarity to the query
  text: string;
  inTopK: boolean;
};

// One row of the experiment's top-k, flagged when it's one of this chunk's pieces.
export type RechunkRankedChunk = {
  rank: number;
  fileName: string | null;
  position: number | null;
  subIndex: number | null;
  text: string;
  score: number;
  isSubChunk: boolean;
};

// Experiment result. The trial knobs (size/overlap) aren't echoed back — the
// caller already submitted them and renders them itself.
export type RechunkResult = {
  subChunkCount: number;
  k: number;
  hit: boolean; // did any sub-chunk land in the top-k?
  bestSubRank: number | null; // best (lowest) rank across all sub-chunks
  topK: RechunkRankedChunk[];
  subChunks: RechunkSubChunk[];
};

// Core: replace the labeled chunk with `subTexts`, embed those, and exact-rank the
// question against the substituted corpus. Reuses the cached query vector (embeds
// only on a cache miss). Nothing is persisted.
async function rankExperiment(
  ctx: ExperimentContext,
  subTexts: string[],
): Promise<RechunkResult> {
  // ctx.queryVector IS the eval query-vector cache (getExperimentContext reads
  // eval_question_embeddings), so the two branches are a hit and a miss — meter
  // them like any other paid embed path.
  const cachedQV = ctx.queryVector;
  const queryVector = cachedQV ?? (await embedQuery(ctx.question));
  await meterEmbeds(
    activeConfig().embeddingModel,
    cachedQV ? [ctx.question] : [],
    cachedQV ? [] : [ctx.question],
  );
  // Cached: repeat experiments at the same size (and any later autotune rung or
  // promoted override over these pieces) reuse the vectors for free.
  const subVectors = await embedDocsCached(subTexts, activeConfig().embeddingModel);

  const k = activeConfig().topK;
  const ranked = await rankWithSubstitutedChunk({
    queryVector,
    sourceChunkId: ctx.chunkId,
    subTexts,
    subVectors,
    k,
  });

  const topK: RechunkRankedChunk[] = ranked
    .filter((r) => r.rank <= k)
    .map((r) => ({
      rank: r.rank,
      fileName: r.fileName,
      position: r.position,
      subIndex: r.subIndex,
      text: r.text,
      score: r.score,
      isSubChunk: r.subIndex !== null,
    }));

  const subChunks: RechunkSubChunk[] = ranked
    .filter((r) => r.subIndex !== null)
    .map((r) => ({
      subIndex: r.subIndex as number,
      rank: r.rank,
      score: r.score,
      text: r.text,
      inTopK: r.rank <= k,
    }))
    .sort((a, b) => a.subIndex - b.subIndex);

  const hit = subChunks.some((s) => s.inTopK);
  const bestSubRank =
    subChunks.length > 0 ? Math.min(...subChunks.map((s) => s.rank)) : null;

  return { subChunkCount: subTexts.length, k, hit, bestSubRank, topK, subChunks };
}

// Uniform sub-divide: split the labeled chunk at a trial (size, overlap) and
// re-rank. Returns null when the question has no label under the active config.
export async function runRechunkExperiment(
  questionId: string,
  size: number,
  overlap: number,
): Promise<RechunkResult | null> {
  const t0 = performance.now();
  const ctx = await getExperimentContext(questionId);
  if (!ctx) return null;

  const subTexts = await splitText(ctx.chunkText, size, overlap);
  const result = await rankExperiment(ctx, subTexts);

  console.log(
    `[rag:eval] rechunk q=${questionId.slice(0, 8)} size=${size} overlap=${overlap}: ` +
      `${result.subChunkCount} sub-chunk(s), hit=${result.hit} ` +
      `bestRank=${result.bestSubRank ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  return result;
}

// Boundary editor: assemble the local window the "resize one custom chunk" mode
// renders. Stitches the labeled chunk + neighbors back into contiguous text (see
// reconstruct.ts), tokenizes it to map token borders to char offsets, and reports
// each chunk's token span so the UI can draw frozen-neighbor bands and the test
// chunk's editable [start, end). Read-only; nothing is persisted.
export type ChunkWindow = {
  testPosition: number;
  totalChunks: number; // chunks in the doc (so the UI knows the range bounds)
  rangeFrom: number; // first/last chunk position included in this window
  rangeTo: number;
  text: string; // stitched window text
  tokenCount: number;
  offsets: number[]; // length tokenCount+1; char index of each token boundary
  chunks: { position: number; tokenStart: number; tokenEnd: number; frozen: boolean }[];
  exclusive: { tokenStart: number; tokenEnd: number }; // test chunk's exclusive zone
  testDefault: { tokenStart: number; tokenEnd: number }; // the test chunk's own span
};

export async function buildChunkWindow(
  questionId: string,
  fromPos: number,
  toPos: number,
): Promise<ChunkWindow | null> {
  const win = await getChunkWindow(questionId, fromPos, toPos);
  if (!win || win.chunks.length === 0) return null;

  const { text, spans } = stitchChunks(win.chunks);
  const { tokenCount, offsets } = await tokenizeWithOffsets(text);

  // First token boundary at or after a char index (binary search over offsets).
  const charToToken = (charIdx: number): number => {
    let lo = 0;
    let hi = tokenCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] < charIdx) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const chunks = spans.map((s) => ({
    position: s.position,
    tokenStart: charToToken(s.charStart),
    tokenEnd: charToToken(s.charEnd),
    frozen: s.position !== win.testPosition,
  }));

  const test = chunks.find((c) => c.position === win.testPosition)!;
  const prev = chunks.filter((c) => c.position < win.testPosition).at(-1);
  const next = chunks.find((c) => c.position > win.testPosition);

  return {
    testPosition: win.testPosition,
    totalChunks: win.totalChunks,
    rangeFrom: win.chunks[0].position,
    rangeTo: win.chunks[win.chunks.length - 1].position,
    text,
    tokenCount,
    offsets,
    chunks,
    // Tokens covered ONLY by the test chunk: between the previous neighbor's end
    // and the next neighbor's start. Shrinking inside this zone leaves a real gap.
    exclusive: {
      tokenStart: prev ? prev.tokenEnd : 0,
      tokenEnd: next ? next.tokenStart : tokenCount,
    },
    testDefault: { tokenStart: test.tokenStart, tokenEnd: test.tokenEnd },
  };
}

// "Try a different model" experiment: an ephemeral per-chunk model A/B.
//
// Re-rank ONE labeled chunk's questions against a small CANDIDATE POOL — the chunk
// itself, the top-k chunks its questions already retrieved, and any hand-picked
// corpus chunks — all re-embedded under an ALTERNATE model. Nothing touches the
// live index; results are ephemeral unless saved (eval_model_trials).
//
// The in-pool rank is a LOCAL APPROXIMATION: it's WITHIN the pool, not the full
// corpus, and it's compared against the question's STORED full-corpus result. Read
// a rescued miss as "this model re-orders the candidates better", not as true
// recall. Re-embedding in memory and ranking by cosine decouples the trial from
// the chunks_<model>_<dim> tables, so any output dimension works.
//
// Each question ALSO gets a FUSED DRY-RUN: the real rank-interleave fusion run
// with a hypothetical override for this chunk layered onto the config's existing
// ones — the exact merged position the chunk would occupy if applied. This is the
// honest number: the in-pool rank routinely over-promises, which is what used to
// surprise on promotion.

// What the trial UI needs to set up a run: the chunk, its questions (with the
// stored baseline), the auto pool (top-k union), and the rest of the corpus to
// pick from — plus the models on offer and any saved trials for this chunk.
export type ModelTrialContext = {
  // Every registry model but the baseline, with the unkeyed ones greyed out —
  // see listTrialModelOptions. Was a hand-maintained list in lib/config.ts,
  // which is how the registry's newer models never reached this picker.
  models: TrialModelOption[];
  baselineModel: string;
  k: number;
  chunk: { chunkId: string; fileName: string; position: number | null; text: string };
  questions: {
    questionId: string;
    question: string;
    storedHit: boolean | null;
    storedRank: number | null;
  }[];
  autoPool: PoolChunk[]; // top-k union across the chunk's questions, minus the chunk
  restCorpus: CorpusChunkListItem[]; // everything else, for the manual picker
  savedTrials: SavedModelTrial[];
  // The model this chunk is currently overridden to in the active config (Phase
  // 5), or null. When set, retrieval ranks this chunk in that model's space.
  currentOverride: string | null;
};

// Which knobs one trial run turns ("try a different configuration"):
//   model      — re-embed the whole chunk under an alternate model (original behavior)
//   size       — re-split the chunk (uniform size/overlap, or custom drag-border
//                sections) under the BASELINE model; it competes as pieces
//   size+model — both: re-split AND embed the pieces under an alternate model
export type TrialVariation =
  | { kind: "model"; model: string }
  | { kind: "size"; size?: number; overlap?: number; sections?: string[] }
  | {
      kind: "size+model";
      model: string;
      size?: number;
      overlap?: number;
      sections?: string[];
    };

// Result of one trial run, returned to the client (ephemeral until saved).
export type ModelTrialResult = {
  model: string;
  baselineModel: string;
  kind: TrialKind;
  chunkSize: number | null; // uniform re-split knobs; null for custom/model-only
  chunkOverlap: number | null;
  pieceCount: number | null; // pieces the chunk competed as (null for model-only)
  k: number;
  poolSize: number;
  pool: PoolChunk[]; // the candidate pool, resolved — for the tooltip + top-k labels
  questionCount: number;
  hitCount: number; // hits under the trial variation (in-pool)
  storedHitCount: number; // baseline hits (stored full-corpus result)
  recall: number | null;
  questions: TrialQuestionOutcome[];
};

const uniq = (ids: string[]): string[] => [...new Set(ids)];

// (cosine + the session embedding cache now live in lib/rag/embedCache.ts,
// shared with the graded-nDCG ranking builder.)

// Assemble the context the trial UI renders. Null when the chunk isn't part of
// the active config's corpus (stale id / wrong config).
export async function getModelTrialContext(
  chunkId: string,
): Promise<ModelTrialContext | null> {
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return null;

  const questions = await getModelTrialQuestions(chunkId);
  // Auto pool = the distractors the chunk's questions already surfaced (the chunk
  // itself is always added at run time, so drop it here to avoid a duplicate).
  const autoIds = uniq(questions.flatMap((q) => q.retrievedIds)).filter((id) => id !== chunkId);

  const [autoPool, restCorpus, savedTrials, overrides] = await Promise.all([
    getChunksByIds(autoIds),
    getCorpusChunkList([chunkId, ...autoIds]),
    listModelTrials(chunkId),
    listOverrides(),
  ]);

  return {
    models: listTrialModelOptions(await availableProviders(), activeConfig().embeddingModel),
    baselineModel: activeConfig().embeddingModel,
    k: activeConfig().topK,
    chunk: {
      chunkId: chunk.chunkId,
      fileName: chunk.fileName,
      position: chunk.position,
      text: chunk.text,
    },
    questions: questions.map((q) => ({
      questionId: q.questionId,
      question: q.question,
      storedHit: q.storedHit,
      storedRank: q.storedRank,
    })),
    autoPool,
    restCorpus,
    savedTrials,
    currentOverride: overrides.find((o) => o.sourceChunkId === chunkId)?.model ?? null,
  };
}

// Promote the ephemeral "try a different model" result into a PERSISTED per-chunk
// override (Phase 5): re-embed the chunk's text under `model` and store it, so
// retrieval ranks this chunk in that model's space (rank-fused — see retriever).
// Returns a status the route maps to an HTTP code. Overriding to the config's own
// base model is rejected (clear the override to use base instead).
export async function setChunkModelOverride(
  chunkId: string,
  model: string,
): Promise<"ok" | "not-found" | "unknown-model" | "unavailable" | "is-base"> {
  let spec;
  try {
    spec = modelSpec(model);
  } catch {
    return "unknown-model";
  }
  if (model === activeConfig().embeddingModel) return "is-base";
  if (!(await availableProviders()).has(spec.provider)) return "unavailable";

  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return "not-found";

  // Cached: autotune's search (and any prior trial) already embedded this
  // exact text under this model, so promoting a winner shouldn't re-pay the
  // provider call.
  const [vector] = await embedDocsCached([chunk.text], model);
  await setChunkOverride(chunkId, model, vector.length, vector);
  return "ok";
}

// Promote a re-chunk experiment into a PERSISTED per-chunk SIZE override (Phase B):
// re-split the chunk at (size, overlap), embed the pieces under the config's BASE
// model, and store them. Retrieval then represents this chunk by its best piece
// (hit = any piece in top-k — see retriever). Token spans stay null: a uniform
// sub-divide covers the whole chunk, so there's no document-coverage gap.
export async function setChunkSizeOverride(
  chunkId: string,
  size: number,
  overlap: number,
): Promise<"ok" | "not-found" | "invalid"> {
  if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size) {
    return "invalid";
  }
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return "not-found";

  const subTexts = await splitText(chunk.text, size, overlap);
  if (subTexts.length === 0) return "invalid";

  // Cached (see setChunkModelOverride) — the search rung that found this size
  // already embedded the identical pieces.
  const vectors = await embedDocsCached(subTexts, activeConfig().embeddingModel);
  const pieces = vectors.map((v, i) => ({
    text: subTexts[i],
    dimension: v.length,
    embedding: v,
  }));
  await setChunkOverridePieces(
    chunkId,
    activeConfig().embeddingModel,
    "size",
    pieces,
    `re-split @ ${size}/${overlap} tokens`,
  );
  return "ok";
}

// Combo override (Phase C): re-split the chunk at (size, overlap) AND embed the
// pieces under an ALTERNATE model — the 'size+model' family the autotune's
// Stage-2/3 search can land on. With the base model this degenerates to a plain
// size override (kind 'size'), so callers don't have to special-case it.
export async function setChunkSizeModelOverride(
  chunkId: string,
  size: number,
  overlap: number,
  model: string,
): Promise<"ok" | "not-found" | "invalid" | "unknown-model" | "unavailable"> {
  if (model === activeConfig().embeddingModel) {
    return setChunkSizeOverride(chunkId, size, overlap);
  }
  let spec;
  try {
    spec = modelSpec(model);
  } catch {
    return "unknown-model";
  }
  if (!(await availableProviders()).has(spec.provider)) return "unavailable";
  if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size) {
    return "invalid";
  }
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return "not-found";

  const subTexts = await splitText(chunk.text, size, overlap);
  if (subTexts.length === 0) return "invalid";

  // Cached (see setChunkModelOverride).
  const vectors = await embedDocsCached(subTexts, model);
  const pieces = vectors.map((v, i) => ({
    text: subTexts[i],
    dimension: v.length,
    embedding: v,
  }));
  await setChunkOverridePieces(
    chunkId,
    model,
    "size+model",
    pieces,
    `re-split @ ${size}/${overlap} tokens + ${model}`,
  );
  return "ok";
}

// Run the trial: embed the pool (with the test chunk replaced by its variation
// pieces) + each question under the variation's model, cosine-rank the chunk
// within the pool per question, and optionally persist the snapshot. For size
// variations the chunk competes as its pieces — its standing is the BEST piece
// (hit = any piece in top-k), matching the rechunk experiment and the override
// retriever. Returns null when the chunk has no questions / isn't under the active
// config; throws on an unknown model or invalid re-split.
export async function runModelTrial(
  chunkId: string,
  variation: TrialVariation,
  poolChunkIds: string[],
  save: boolean,
): Promise<{ result: ModelTrialResult; savedTrial: SavedModelTrial | null } | null> {
  const baselineModel = activeConfig().embeddingModel;
  const model = variation.kind === "size" ? baselineModel : variation.model;
  if (variation.kind !== "size") {
    // Two separate failures with two separate fixes, so they get two messages:
    // an id the registry has never heard of is a bad request, while a keyless
    // provider is a keyed-model-away from working. The picker already greys the
    // latter out — this is the guard for a hand-rolled request.
    let spec;
    try {
      spec = modelSpec(model);
    } catch {
      throw new Error(`Unknown model "${model}".`);
    }
    if (!(await availableProviders()).has(spec.provider)) {
      throw new Error(`Cannot try "${model}" — ${unavailableReason(spec.provider)}.`);
    }
  }

  const t0 = performance.now();
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return null;
  const questions = await getModelTrialQuestions(chunkId);
  if (questions.length === 0) return null;

  // How the test chunk enters the pool: whole (model-only) or as pieces.
  let pieceTexts = [chunk.text];
  let chunkSize: number | null = null;
  let chunkOverlap: number | null = null;
  if (variation.kind !== "model") {
    if (variation.sections && variation.sections.length > 0) {
      pieceTexts = variation.sections;
    } else if (variation.size !== undefined) {
      const size = variation.size;
      const overlap = variation.overlap ?? 0;
      if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size) {
        throw new Error("Invalid size/overlap (need size ≥ 1 and 0 ≤ overlap < size).");
      }
      pieceTexts = await splitText(chunk.text, size, overlap);
      if (pieceTexts.length === 0) {
        throw new Error("Re-split produced no pieces.");
      }
      chunkSize = size;
      chunkOverlap = overlap;
    } else {
      throw new Error("A size variation needs `size` (+ optional overlap) or `sections`.");
    }
  }
  const pieceCount = variation.kind === "model" ? null : pieceTexts.length;

  // The chunk is always in the pool (it's the ground truth we're ranking).
  const poolIds = uniq([chunkId, ...poolChunkIds]);
  const poolChunks = await getChunksByIds(poolIds);
  if (!poolChunks.some((c) => c.chunkId === chunkId)) return null; // dropped mid-run
  const otherChunks = poolChunks.filter((c) => c.chunkId !== chunkId);

  const [pieceVectors, otherVectors] = await Promise.all([
    embedDocsCached(pieceTexts, model),
    embedDocsCached(otherChunks.map((c) => c.text), model),
  ]);
  const otherVecById = new Map(otherChunks.map((c, i) => [c.chunkId, otherVectors[i]]));

  // Fused dry-run state: the config's overrides with THIS chunk's entry replaced
  // by the trial variation — what promotion would actually persist. Pieces for
  // the trial model are the in-memory trial vectors; other models keep their
  // stored pieces (minus this chunk's, if it's currently overridden elsewhere).
  // Memoized per model: fuseWithOverrides asks once per model per question.
  const hypOverrides: ChunkOverride[] = [
    ...(await listOverrides()).filter((o) => o.sourceChunkId !== chunkId),
    { sourceChunkId: chunkId, model, kind: variation.kind },
  ];
  const pieceCache = new Map<string, Promise<OverrideEmbedding[]>>();
  const piecesFor = (m: string): Promise<OverrideEmbedding[]> => {
    let p = pieceCache.get(m);
    if (!p) {
      p = overrideEmbeddings(m).then((stored) => {
        const kept = stored.filter((piece) => piece.chunkId !== chunkId);
        return m === model
          ? [...kept, ...pieceVectors.map((embedding) => ({ chunkId, embedding }))]
          : kept;
      });
      pieceCache.set(m, p);
    }
    return p;
  };

  const k = activeConfig().topK;
  const questionsOut: TrialQuestionOutcome[] = [];
  for (const q of questions) {
    const qVec = await embedQueryCached(q.question, model);
    // One candidate row per piece + one per other pool chunk.
    const scored: { id: string; subIndex: number | null; sim: number }[] = [
      ...pieceVectors.map((v, i) => ({
        id: chunkId,
        subIndex: pieceCount === null ? null : i,
        sim: cosine(qVec, v),
      })),
      ...otherChunks.map((c) => ({
        id: c.chunkId,
        subIndex: null,
        sim: cosine(qVec, otherVecById.get(c.chunkId)!),
      })),
    ];
    scored.sort((a, b) => b.sim - a.sim);
    const newRank = scored.findIndex((s) => s.id === chunkId) + 1; // best piece, 1-based
    const topPool: TrialPoolHit[] = scored.slice(0, k).map((s, i) => ({
      chunkId: s.id,
      rank: i + 1,
      score: s.sim,
      isExpected: s.id === chunkId,
      subIndex: s.subIndex,
    }));
    // The chunk's own sim = its best piece's sim (max over pieces).
    const newScore = Math.max(
      ...scored.filter((s) => s.id === chunkId).map((s) => s.sim),
    );

    // Fused dry-run: the chunk's merged position under REAL rank-fused
    // retrieval with the hypothetical override applied. The chunk is always in
    // the merged list (every overridden chunk is), so the rank is always found.
    const baseQVec = await embedQueryCached(q.question, baselineModel);
    const { merged } = await fuseWithOverrides(
      q.question,
      baseQVec,
      k,
      hypOverrides,
      piecesFor,
    );
    const fusedRank = merged.findIndex((c) => c.id === chunkId) + 1;

    questionsOut.push({
      questionId: q.questionId,
      question: q.question,
      storedHit: q.storedHit,
      storedRank: q.storedRank,
      newHit: newRank >= 1 && newRank <= k,
      newRank,
      newScore,
      fusedRank,
      fusedHit: fusedRank >= 1 && fusedRank <= k,
      topPool,
    });
  }

  const hitCount = questionsOut.filter((o) => o.newHit).length;
  const storedHitCount = questionsOut.filter((o) => o.storedHit === true).length;
  const result: ModelTrialResult = {
    model,
    baselineModel,
    kind: variation.kind,
    chunkSize,
    chunkOverlap,
    pieceCount,
    k,
    poolSize: poolChunks.length,
    pool: poolChunks,
    questionCount: questionsOut.length,
    hitCount,
    storedHitCount,
    recall: questionsOut.length > 0 ? hitCount / questionsOut.length : null,
    questions: questionsOut,
  };

  let savedTrial: SavedModelTrial | null = null;
  if (save) {
    const ins = await insertModelTrial({
      sourceChunkId: chunkId,
      documentEmbeddingId: chunk.documentEmbeddingId,
      baselineModel,
      trialModel: model,
      kind: variation.kind,
      chunkSize,
      chunkOverlap,
      pieceCount,
      k,
      poolChunkIds: poolIds,
      questionCount: questionsOut.length,
      hitCount,
      storedHitCount,
      results: questionsOut,
    });
    savedTrial = {
      id: ins.id,
      baselineModel,
      trialModel: model,
      kind: variation.kind,
      chunkSize,
      chunkOverlap,
      pieceCount,
      k,
      poolSize: poolIds.length,
      pool: poolChunks,
      questionCount: questionsOut.length,
      hitCount,
      storedHitCount,
      results: questionsOut,
      createdAt: ins.createdAt,
    };
  }

  console.log(
    `[rag:eval] config-trial chunk=${chunkId.slice(0, 8)} kind=${variation.kind} model=${model} ` +
      `pieces=${pieceCount ?? 1} pool=${poolChunks.length} q=${questionsOut.length} ` +
      `hits=${hitCount}/${questionsOut.length} ` +
      `fused=${questionsOut.filter((o) => o.fusedHit).length}/${questionsOut.length} ` +
      `${save ? "(saved) " : ""}` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );
  return { result, savedTrial };
}
