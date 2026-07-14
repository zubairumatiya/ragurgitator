// ---------------------------------------------------------------------------
// EVAL ENGINE: synthetic Recall@k for retrieval.
//
// For each chunk we ask the LLM to author a natural question the chunk answers
// (the chunk is the ground-truth label). Scoring is pure retrieval — embed the
// question, vector-search, and check whether the labeled chunk is in the top-k.
// No LLM runs at scoring time.
//
// Known limitations (by design for v1):
//   - Strict chunk-id match can undercount when overlapping/duplicate chunks
//     legitimately answer the same question — a recall floor, not a bug.
//   - Synthetic questions skew easier than real user queries, so recall is an
//     optimistic estimate; the generation prompt mitigates lexical copying.
//   - Retrieval searches the whole model+dim chunks table (all docs/configs that
//     share it); fine with today's single fixed config.
// ---------------------------------------------------------------------------
import { altEmbeddingModels } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  addDifficulty,
  effectiveK,
  getActiveCriteria,
  retrievalDepth,
} from "@/lib/rag/evalSettingsStore";
import { isProviderAvailable, modelSpec } from "@/lib/rag/embeddingModels";
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
import { anthropicClient } from "@/lib/llm/client";
import { splitText, tokenizeWithOffsets } from "@/lib/rag/chunker";
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { embedQuery, embedTexts } from "@/lib/rag/embeddings";
import { stitchChunks } from "@/lib/rag/reconstruct";
import { fuseWithOverrides, retrieveForQuery } from "@/lib/rag/retriever";
import {
  allLabeledQuestions,
  chunksNeedingQuestionsByDifficulty,
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
  listModelTrials,
  putCachedQueryEmbedding,
  questionsNeedingScoring,
  rankWithSubstitutedChunk,
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
  | {
      type: "done";
      generated: number;
      scored: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
    }
  | { type: "error"; message: string };

type Emit = (event: EvalEvent) => void;

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

async function authorQuestions(
  text: string,
  count: number,
  difficulty?: Difficulty,
): Promise<GeneratedQuestion[]> {
  // The difficulty steer (when set) leads the user turn; the passage follows.
  const steer = difficulty ? `${difficultyInstruction(difficulty)}\n\n` : "";
  const response = await anthropicClient.messages.create({
    model: activeConfig().llmModel,
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
        content:
          `${steer}Write exactly ${count} question(s) for this passage:\n\n${text}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  // Structured outputs guarantee schema-valid JSON on a clean stop, but a
  // truncation (max_tokens) or refusal can still yield unparseable text. Skip
  // this chunk rather than failing the whole run — it stays under target and is
  // retried on the next pass.
  try {
    const parsed = JSON.parse(textBlock.text) as { questions?: GeneratedQuestion[] };
    return (parsed.questions ?? []).slice(0, count);
  } catch {
    console.warn(
      `[rag:eval] could not parse generated questions (stop_reason=${response.stop_reason}); skipping chunk`,
    );
    return [];
  }
}

// Generate one question per SELECTED difficulty for every chunk that's missing
// one at that difficulty (Phase A — criteria-driven generation). An empty
// difficulty set is a no-op, so a config that hasn't opted into a difficulty mix
// never auto-synthesizes (the user picks via Settings / Bulk actions). Each gap
// is its own progress step so the bar reflects per-(chunk,difficulty) work.
export async function generateMissingQuestions(
  difficulties: Difficulty[],
  emit: Emit = () => {},
  documentIds?: string[],
): Promise<number> {
  if (difficulties.length === 0) return 0;
  const gaps = await chunksNeedingQuestionsByDifficulty(difficulties, documentIds);
  if (gaps.length === 0) return 0;

  console.log(
    `[rag:eval] generating ${gaps.length} question(s) across difficulties [${difficulties.join(", ")}]`,
  );
  emit({ type: "generate-start", total: gaps.length });

  let generated = 0;
  let done = 0;
  for (const gap of gaps) {
    const [q] = await authorQuestions(gap.text, 1, gap.difficulty as Difficulty);
    let landed: GeneratedQuestionPayload | undefined;
    if (q && q.question.trim()) {
      const questionId = await insertQuestionWithLabel({
        documentId: gap.documentId,
        documentEmbeddingId: gap.documentEmbeddingId,
        sourceChunkId: gap.chunkId,
        question: q.question.trim(),
        expectedAnswer: q.expected_answer?.trim() || null,
        generatorModel: activeConfig().llmModel,
        difficulty: gap.difficulty,
      });
      generated += 1;
      landed = {
        questionId,
        question: q.question.trim(),
        difficulty: gap.difficulty,
        documentId: gap.documentId,
        fileName: gap.fileName,
        sourceChunkId: gap.chunkId,
        expectedPosition: gap.position,
      };
    }
    done += 1;
    emit({ type: "generate-progress", done, total: gaps.length, question: landed });
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

  const [q] = await authorQuestions(chunk.text, 1, difficulty);
  if (!q || !q.question.trim()) return "empty";

  await insertQuestionWithLabel({
    documentId: chunk.documentId,
    documentEmbeddingId: chunk.documentEmbeddingId,
    sourceChunkId: chunkId,
    question: q.question.trim(),
    expectedAnswer: q.expected_answer?.trim() || null,
    generatorModel: activeConfig().llmModel,
    difficulty,
  });
  return "ok";
}

// Embed each question, vector-search, and record whether its labeled chunk landed in
// the top-k. Pure retrieval — no LLM at scoring time. Shared by the incremental
// (scoreUnscoredQuestions) and full (rescoreAllQuestions) scoring paths.
//
// A question's query vector depends only on (text, model), so we reuse cached
// vectors and embed only cache misses (caching them as we go). On a warm cache
// each iteration is just a fast vector search — the win that makes repeat
// "Re-score all" runs cheap. Misses still embed one-at-a-time inside the loop so
// the per-question progress bar stays accurate.
async function scoreQuestions(
  questions: QuestionToScore[],
  emit: Emit = () => {},
): Promise<number> {
  if (questions.length === 0) return 0;

  emit({ type: "score-start", total: questions.length });

  const cfg = activeConfig();
  // Retrieve a superset deep enough for every enabled metric, then judge recall
  // at recall_k (A1). Loading criteria once per run (not per question) is cheap.
  const criteria = await getActiveCriteria();
  const depth = retrievalDepth(criteria, cfg.topK);
  const recallK = effectiveK(criteria.recall, cfg.topK);

  const cached = await getCachedQueryEmbeddings(
    questions.map((q) => q.questionId),
    cfg.embeddingModel,
  );
  // Stamp every result with the override state it's scored under (0022) — the
  // state can't change mid-run, so one fingerprint covers the batch.
  const retrievalState = await retrievalStateFingerprint();

  const results: ResultInsert[] = [];
  let done = 0;
  for (const q of questions) {
    let vector = cached.get(q.questionId);
    if (!vector) {
      vector = await embedQuery(q.question);
      await putCachedQueryEmbedding(q.questionId, cfg.embeddingModel, vector);
    }
    // Pass the question text too: override configs embed it under the override
    // models for the rank-interleave fusion; non-override configs ignore it (base vector only).
    const retrieved = await retrieveForQuery(q.question, vector, depth);
    const ids = retrieved.map((r) => r.chunk.chunk.id);
    const scores = retrieved.map((r) => r.score);
    const rank = ids.indexOf(q.sourceChunkId);
    const foundRank = rank === -1 ? null : rank + 1;
    // Hit = the ground truth landed within recall_k of the retrieved superset.
    const hit = foundRank !== null && foundRank <= recallK;
    results.push({
      questionId: q.questionId,
      labelId: q.labelId,
      k: recallK,
      hit,
      foundRank,
      retrievedIds: ids,
      retrievedScores: scores,
      retrievalState,
    });
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

  await insertResults(results);
  return results.length;
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
export async function scoreUnscoredQuestions(emit: Emit = () => {}): Promise<number> {
  const pending = await questionsNeedingScoring();
  if (pending.length === 0) return 0;
  console.log(`[rag:eval] scoring ${pending.length} question(s) @ k=${activeConfig().topK}`);
  return scoreQuestions(pending, emit);
}

// The "Process new chunks" button: generate questions for new chunks, score
// what's unscored, then freeze a comparison snapshot of the current aggregate.
export async function processNewChunks(emit: Emit = () => {}): Promise<{
  generated: number;
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const criteria = await getActiveCriteria();
  const generated = await generateMissingQuestions(criteria.difficulties, emit);
  const scored = await scoreUnscoredQuestions(emit);
  // Everything pending (incl. retrieval-stale) is fresh now — the logged
  // override changes are baked into the rates, so the stale badge can drop.
  await clearRetrievalChanges();

  const summary = await getSummary();
  // Only snapshot when something actually changed, so repeated clicks don't
  // pile up identical run rows.
  if (generated > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }

  console.log(
    `[rag:eval] processNewChunks done: generated=${generated} scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    generated,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { generated, scored, recall: summary.recall };
}

// "Bulk actions → Add question → {difficulty}": persist the difficulty into the
// config's mix, then generate one question at that difficulty for every chunk
// missing one, score the unscored, and freeze a snapshot. Streams EvalEvents like
// processNewChunks so the dashboard reuses the same progress UI.
export async function bulkAddDifficulty(
  difficulty: Difficulty,
  emit: Emit = () => {},
  documentIds?: string[],
): Promise<{ generated: number; scored: number; recall: number | null }> {
  await addDifficulty(difficulty);
  const generated = await generateMissingQuestions([difficulty], emit, documentIds);
  const scored = await scoreUnscoredQuestions(emit);

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
    generated,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { generated, scored, recall: summary.recall };
}

// The "Re-score all" button: re-run retrieval for EVERY labeled question under the
// active config against the current corpus and freeze a snapshot. Unlike
// processNewChunks this ignores existing results (it inserts fresh rows; history is
// preserved), so recall stays apples-to-apples after the corpus changes — e.g. a newly
// added doc introduces distractors that can push a previously-hit chunk out of the
// top-k. Generation is untouched; this only scores.
export async function rescoreAllQuestions(
  emit: Emit = () => {},
  documentIds?: string[],
): Promise<{
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const questions = await allLabeledQuestions(documentIds);
  console.log(
    `[rag:eval] re-scoring all ${questions.length} question(s) @ k=${activeConfig().topK}`,
  );
  const scored = await scoreQuestions(questions, emit);
  // An unscoped re-score refreshes every result; a document-scoped one leaves
  // other documents' stale rows (and thus the badge's change log) in place.
  if (!documentIds || documentIds.length === 0) await clearRetrievalChanges();

  const summary = await getSummary();
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
    `[rag:eval] rescoreAllQuestions done: scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    generated: 0,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { scored, recall: summary.recall };
}

// ---------------------------------------------------------------------------
// Re-chunk experiment: an ephemeral per-chunk "what-if" (autotune Stage 1).
//
// Re-split ONE labeled chunk at a trial (size, overlap), embed the pieces, and
// re-rank the question against a corpus where that chunk is replaced by its
// sub-chunks. Nothing is persisted — no new chunks, no scores, no config change
// — so the live retrieval index and every other question's score are untouched.
//
// This is a LOCAL APPROXIMATION of a full re-chunk: the chunk's document
// neighbors stay frozen, so the seams between this chunk and its neighbors are
// not re-formed (overlap only moves this chunk's INTERNAL seams). Size is the
// high-signal knob here; read overlap results with that caveat. Ranking is an
// exact full-scan against the substituted corpus (see rankWithSubstitutedChunk)
// — no pool approximation, unlike the model trials below.
// ---------------------------------------------------------------------------

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
  const queryVector = ctx.queryVector ?? (await embedQuery(ctx.question));
  const subVectors = await embedTexts(subTexts);

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

// ---------------------------------------------------------------------------
// Boundary editor: assemble the local window the "resize one custom chunk" mode
// renders. Stitches the labeled chunk + neighbors back into contiguous text (see
// reconstruct.ts), tokenizes it to map token borders to char offsets, and reports
// each chunk's token span so the UI can draw frozen-neighbor bands and the test
// chunk's editable [start, end). Read-only; nothing is persisted.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// "Try a different model" experiment: an ephemeral per-chunk model A/B.
//
// Re-rank ONE labeled chunk's questions against a small CANDIDATE POOL — the
// chunk itself, the top-k chunks its questions already retrieved, and any corpus
// chunks the user hand-picked — all re-embedded under an ALTERNATE model. For
// each question we cosine-rank the ground-truth chunk within the pool and check
// the top-k. Nothing touches the live index; results are ephemeral unless the
// user saves a snapshot (eval_model_trials).
//
// The in-pool rank is a LOCAL APPROXIMATION: the new-model rank is WITHIN the
// pool, not the full corpus, and it's compared against the question's STORED
// full-corpus result (the baseline). The pool is far smaller than the corpus,
// so read a rescued miss as "this model re-orders the candidates better," not
// as true recall. We re-embed in memory and rank by cosine (not pgvector), so
// the trial is decoupled from the chunks_<model>_<dim> tables and any output
// dimension works.
//
// Each question ALSO gets a FUSED DRY-RUN (fusedRank/fusedHit): the real
// rank-interleave fusion (retriever.fuseWithOverrides) run with a hypothetical
// override for this chunk layered onto the config's existing overrides — the
// exact merged position the chunk would occupy if the variation were applied.
// This is the honest number: the in-pool rank routinely over-promises (a chunk
// that's #1 among ~10 pool chunks can be #3+ against the base ANN's full
// candidate list), which is exactly what used to surprise on promotion.
// ---------------------------------------------------------------------------

// What the trial UI needs to set up a run: the chunk, its questions (with the
// stored baseline), the auto pool (top-k union), and the rest of the corpus to
// pick from — plus the models on offer and any saved trials for this chunk.
export type ModelTrialContext = {
  models: { id: string; label: string }[];
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
    models: altEmbeddingModels,
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
  if (!isProviderAvailable(spec.provider)) return "unavailable";

  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return "not-found";

  const [vector] = await embedTexts([chunk.text], model);
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

  const vectors = await embedTexts(subTexts);
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
  if (!isProviderAvailable(spec.provider)) return "unavailable";
  if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size) {
    return "invalid";
  }
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return "not-found";

  const subTexts = await splitText(chunk.text, size, overlap);
  if (subTexts.length === 0) return "invalid";

  const vectors = await embedTexts(subTexts, model);
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
// within the pool per question, and (optionally) persist the snapshot. For size
// variations the chunk competes as its pieces — its standing per question is the
// BEST piece (hit = any piece in top-k), matching the rechunk experiment and the
// override retriever. Returns null when the chunk has no questions / isn't under
// the active config; throws on an unknown model or invalid re-split.
export async function runModelTrial(
  chunkId: string,
  variation: TrialVariation,
  poolChunkIds: string[],
  save: boolean,
): Promise<{ result: ModelTrialResult; savedTrial: SavedModelTrial | null } | null> {
  const baselineModel = activeConfig().embeddingModel;
  const model = variation.kind === "size" ? baselineModel : variation.model;
  if (
    variation.kind !== "size" &&
    !altEmbeddingModels.some((m) => m.id === model)
  ) {
    throw new Error(`Unknown model "${model}".`);
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
