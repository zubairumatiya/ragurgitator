// SEMANTIC CACHE — the GENERATED eval pair set (0040).
//
// A pair is two question texts plus one ANSWER-LEVEL label: would a single answer
// serve both? That framing is load-bearing. A shadow verdict asks "would this stored
// ANSWER serve this new question"; a naive generated pair asks "are these two
// questions the same". Pooling those two as-is would mix two different targets, so
// the generation prompt below is written against the ANSWER-level one.
//
// Two halves, split the same way question generation is:
//   - pairRequestParams / parsePairs — the prompt + parse, shared verbatim by the
//     inline path and the batch path, so the two can never drift.
//   - the store — gap query, insert, read-back for the sweep.
//
// Best-effort against a missing table (42P01): the sweep falls back to a
// shadow-only pair set.
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

import { config } from "@/lib/config";
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { meteredMessage } from "@/lib/rag/meter";

export type PairLabel = "same" | "different";
export type PairDifficulty = "paraphrase" | "hard-negative";

export type EvalPair = {
  textA: string;
  textB: string;
  label: PairLabel;
  difficulty: PairDifficulty;
};

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// --- prompt + parse (shared by the inline and batch paths) -------------------

// HARD NEGATIVES ARE THE WHOLE POINT. Random distinct questions are separated
// near-perfectly by every embedding model — they push AUC toward 0.99 and
// discriminate nothing. Models only differ on same-topic/different-answer pairs,
// so the eval is exactly as good as its hard negatives, and the prompt spends
// most of its words on them.
const PAIRS_SYSTEM = `You build evaluation data for a semantic ANSWER cache used by a retrieval-augmented question-answering system.

Given an ORIGINAL question (and, when available, the answer it has), you write two kinds of variant question:

PARAPHRASES (label: the original's answer WOULD fully serve them)
- Same information need, different wording: synonyms, reordering, formality, politeness padding, abbreviation.
- A user asking the paraphrase would be completely satisfied by the original question's answer. If they would need even one extra fact, it is NOT a paraphrase.

HARD NEGATIVES (label: the original's answer would NOT serve them)
- Same topic, same vocabulary, same shape — but a DIFFERENT answer is required.
- Aim for pairs that sit close together in embedding space. The best ones change exactly one load-bearing detail:
  * a number, year, or amount ("2023 revenue" vs "2024 revenue")
  * a named entity or scope ("vacation policy for full-time" vs "for contractors")
  * a qualifier that flips the ask ("how do I enroll" vs "how do I cancel")
  * an aggregation or unit ("total" vs "per employee", "monthly" vs "annual")
- Do NOT write an unrelated question about another topic. A negative that is obviously different is worthless here — every model already separates those.

Write natural questions a real user would type. Do not number them, do not explain them, and do not repeat the original question verbatim in either list.`;

const PAIRS_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      paraphrases: { type: "array", items: { type: "string" } },
      hard_negatives: { type: "array", items: { type: "string" } },
    },
    required: ["paraphrases", "hard_negatives"],
    additionalProperties: false,
  },
};

// The Anthropic request params for one origin question. `model` is passed in
// rather than read from config so this stays scope-free and can be rebuilt when
// a batch is APPLIED, long after the request that launched it.
export function pairRequestParams(
  question: string,
  expectedAnswer: string | null,
  counts: { paraphrase: number; hardNegative: number },
  model: string,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const answerBlock = expectedAnswer
    ? `\n\nIts answer:\n${expectedAnswer}`
    : "\n\n(No stored answer — judge servability from the question alone.)";
  return {
    model,
    // Headroom scales with the ask so a larger target can't truncate the JSON.
    max_tokens: Math.min(1024 + (counts.paraphrase + counts.hardNegative) * 128, 4096),
    thinking: { type: "disabled" },
    output_config: { format: PAIRS_FORMAT },
    system: [
      { type: "text", text: PAIRS_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content:
          `Original question:\n${question}${answerBlock}\n\n` +
          `Write exactly ${counts.paraphrase} paraphrase(s) and ` +
          `${counts.hardNegative} hard negative(s).`,
      },
    ],
  };
}

// Parse a generation response — an inline Message OR a batch result body — into
// the two lists. Structured outputs guarantee schema-valid JSON on a clean stop,
// but a truncation or refusal can still yield unparseable text: return empty
// lists and let that question stay in the gap for the next pass.
export function parsePairs(message: {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}): { paraphrases: string[]; hardNegatives: string[] } {
  const empty = { paraphrases: [], hardNegatives: [] };
  const block = message.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") return empty;
  try {
    const parsed = JSON.parse(block.text) as {
      paraphrases?: unknown;
      hard_negatives?: unknown;
    };
    const clean = (v: unknown): string[] =>
      Array.isArray(v)
        ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
            .map((s) => s.trim()))]
        : [];
    return { paraphrases: clean(parsed.paraphrases), hardNegatives: clean(parsed.hard_negatives) };
  } catch {
    return empty;
  }
}

// Turn one parsed response into storable pairs. Kept next to the parse so the
// inline and batch paths label identically: a paraphrase is 'same' (one answer
// serves both), a hard negative is 'different'.
export function pairsFrom(
  originText: string,
  parsed: { paraphrases: string[]; hardNegatives: string[] },
): EvalPair[] {
  return [
    ...parsed.paraphrases.map((t) => ({
      textA: originText,
      textB: t,
      label: "same" as const,
      difficulty: "paraphrase" as const,
    })),
    ...parsed.hardNegatives.map((t) => ({
      textA: originText,
      textB: t,
      label: "different" as const,
      difficulty: "hard-negative" as const,
    })),
  ].filter((p) => p.textB !== p.textA);
}

// --- store -------------------------------------------------------------------

export type PairGap = { questionId: string; question: string; expectedAnswer: string | null };

// Eval questions in the ACTIVE config's bank that have no generated pairs yet,
// so a re-run tops up instead of re-paying for what exists. Scoped through
// eval_labels → document_embeddings exactly like allLabeledQuestions: a question
// only counts once it's labeled against this config's corpus, which is also what
// makes its answer-level pair labels checkable.
export async function questionsNeedingPairs(limit = 200): Promise<PairGap[]> {
  const rows = await sql<
    { id: string; question: string; expected_answer: string | null }[]
  >`
    select distinct q.id, q.question, q.expected_answer
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${activeConfig().id}
      and not exists (
        select 1 from semantic_cache_pairs p where p.origin_question_id = q.id
      )
    limit ${limit}
  `;
  return rows.map((r) => ({
    questionId: r.id,
    question: r.question,
    expectedAnswer: r.expected_answer,
  }));
}

// Insert generated pairs. The unique key is (origin_question_id, hash_a, hash_b)
// since 0050 — the conflict target MUST name all three or postgres rejects the
// statement outright (42P10, "no unique or exclusion constraint matching"), which
// is what happened between 0050 and this line being updated: every pair insert
// threw, on the inline path and the batch-apply path alike, and generatePairs
// counted it as a skip.
//
// Within that key the texts are still stored in a CANONICAL orientation (lower
// hash first) — the label is symmetric, so orientation carries no information, and
// without canonicalizing, one question could store the same text pair twice under
// both orders and have it counted twice by the sweep. Idempotent via on-conflict,
// so re-applying a batch is safe.
export async function insertPairs(
  originQuestionId: string,
  pairs: EvalPair[],
  generatedBy: string,
): Promise<number> {
  let inserted = 0;
  for (const p of pairs) {
    const ha = sha256(p.textA);
    const hb = sha256(p.textB);
    const flip = hb < ha;
    const [textA, textB, hashA, hashB] = flip
      ? [p.textB, p.textA, hb, ha]
      : [p.textA, p.textB, ha, hb];
    const done = await sql`
      insert into semantic_cache_pairs
        (origin_question_id, text_a, text_b, hash_a, hash_b, label, difficulty, generated_by)
      values
        (${originQuestionId}, ${textA}, ${textB}, ${hashA}, ${hashB},
         ${p.label}, ${p.difficulty}, ${generatedBy})
      on conflict (origin_question_id, hash_a, hash_b) do nothing
    `;
    inserted += done.count;
  }
  return inserted;
}

// The verdict a constructed label predicts: 'same' claims one answer serves both
// (the judge would accept the match), 'different' claims it does not. This is the
// single place the two vocabularies are tied together — the pair table's labels
// and the shadow judge's verdicts — and F3's whole measurement is how often the
// generator's claim survives contact with a judge.
export const expectedVerdict = (label: PairLabel): "accept" | "reject" =>
  label === "same" ? "accept" : "reject";

// The whole generated set, for the sweep. Global (not config-scoped): a pair is
// a property of two question texts, not of a config, and pooling every label
// into one set is the point — see the plan doc's "Pooling" section.
//
// QUARANTINE (F3). A row whose final verdict CONTRADICTS its constructed label is
// excluded: the sweep grades candidate models against these labels, so a
// "hard negative" that is really a paraphrase punishes exactly the models that
// score it correctly. The filter is deliberately `verdict is null or
// verdict = expected(label)` and not `verdict = expected(label)` — unjudged rows
// must still flow through, or the sweep silently empties for any account that has
// never run F3. Verdicts are dropped rather than relabelled; see the plan doc's
// "Considered and not doing".
export async function listPairs(): Promise<EvalPair[]> {
  try {
    const rows = await sql<
      { text_a: string; text_b: string; label: PairLabel; difficulty: PairDifficulty }[]
    >`
      select p.text_a, p.text_b, p.label, p.difficulty
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
      where d.user_id = ${activeUserId()}
        and (
          p.verdict is null
          or p.verdict = case when p.label = 'same' then 'accept' else 'reject' end
        )
    `;
    return rows.map((r) => ({
      textA: r.text_a,
      textB: r.text_b,
      label: r.label,
      difficulty: r.difficulty,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// --- audit read path (F3) ----------------------------------------------------

export type PairForJudging = {
  id: string;
  // The ORIGIN question — the one the pair was generated from, whose answer the
  // cache would be serving. Resolved from eval_questions, NOT from text_a.
  originText: string;
  // The generated variant: the paraphrase or hard negative under test.
  variantText: string;
  expectedAnswer: string | null;
  label: PairLabel;
  difficulty: PairDifficulty;
  verdict: "accept" | "reject" | null;
  verdictSource: "llm" | "human" | null;
  judgeReason: string | null;
};

// Every pair with its origin/variant roles RESOLVED, for the F3 audit.
//
// WHY THIS CANNOT READ text_a AS THE ORIGIN. 0040's column comments say text_a is
// the origin and text_b the variant, and that was true as written — but insertPairs
// stores the pair in a CANONICAL orientation (lower sha256 first) so one question
// can't bank the same text pair under both orders. The flip is content-addressed
// and therefore effectively random: of the 216 rows in this database, text_a is the
// origin in 98 and text_b in the other 118. Judging with a fixed (matched = text_a,
// new = text_b) assignment would hand the judge the variant as the STORED question
// for more than half the set — a different question than the one the cache actually
// keys on, with the origin's answer attached to it.
//
// eval_questions.question is the authority. The pair is skipped rather than guessed
// if neither text matches it, which can only happen if a question was edited after
// its pairs were generated — the hashes would no longer agree either, so there is no
// safe repair to make here.
export function variantOf(
  textA: string,
  textB: string,
  originQuestion: string,
): string | null {
  if (textA === originQuestion) return textB;
  if (textB === originQuestion) return textA;
  return null;
}

export async function pairsForJudging(): Promise<PairForJudging[]> {
  const rows = await sql<
    {
      id: string;
      text_a: string;
      text_b: string;
      question: string;
      expected_answer: string | null;
      label: PairLabel;
      difficulty: PairDifficulty;
      verdict: "accept" | "reject" | null;
      verdict_source: "llm" | "human" | null;
      judge_reason: string | null;
    }[]
  >`
    select p.id, p.text_a, p.text_b, q.question, q.expected_answer,
           p.label, p.difficulty, p.verdict, p.verdict_source, p.judge_reason
    from semantic_cache_pairs p
    join eval_questions q on q.id = p.origin_question_id
    join documents d on d.id = q.document_id
    where d.user_id = ${activeUserId()}
    order by p.difficulty, p.id
  `;
  return rows.flatMap((r) => {
    const variantText = variantOf(r.text_a, r.text_b, r.question);
    if (variantText === null) return [];
    return [
      {
        id: r.id,
        originText: r.question,
        variantText,
        expectedAnswer: r.expected_answer,
        label: r.label,
        difficulty: r.difficulty,
        verdict: r.verdict,
        verdictSource: r.verdict_source,
        judgeReason: r.judge_reason,
      },
    ];
  });
}

// Record a verdict. A HUMAN verdict is final and is never overwritten by a later
// LLM pass — same rule as the shadow log's setHumanVerdict — so an adjudicated
// row survives a re-judge of the whole table.
export async function setPairVerdict(
  id: string,
  verdict: "accept" | "reject",
  source: "llm" | "human",
  judgeModel: string | null,
  reason: string | null,
): Promise<void> {
  await sql`
    update semantic_cache_pairs
    set verdict = ${verdict}, verdict_source = ${source},
        judge_model = ${judgeModel}, judge_reason = ${reason}, judged_at = now()
    where id = ${id}
      and (${source} = 'human' or verdict_source is distinct from 'human')
  `;
}

export type PairStats = {
  total: number;
  same: number;
  different: number;
  questionsCovered: number;
  questionsRemaining: number;
  // Rows a verdict contradicts, which listPairs excludes. Counted separately from
  // `total` rather than deducted from it: the panel offers to GENERATE more pairs,
  // and a quarantined row still occupies its origin question (so generation will
  // not top it up) even though the sweep no longer scores it. Reporting one number
  // would make one of those two readings wrong.
  quarantined: number;
};

// Counts for the panel: what exists, and how much of the bank still has no
// pairs (so "Generate" can say what it would cost before it's clicked).
export async function pairStats(): Promise<PairStats> {
  const empty: PairStats = {
    total: 0,
    same: 0,
    different: 0,
    questionsCovered: 0,
    questionsRemaining: 0,
    quarantined: 0,
  };
  try {
    const [row] = await sql<
      { total: number; same: number; different: number; covered: number; quarantined: number }[]
    >`
      select count(*)::int as total,
             count(*) filter (where p.label = 'same')::int as same,
             count(*) filter (where p.label = 'different')::int as different,
             count(distinct p.origin_question_id)::int as covered,
             count(*) filter (
               where p.verdict is not null
                 and p.verdict <> case when p.label = 'same' then 'accept' else 'reject' end
             )::int as quarantined
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
      where d.user_id = ${activeUserId()}
    `;
    const remaining = (await questionsNeedingPairs(10_000)).length;
    return {
      total: row?.total ?? 0,
      same: row?.same ?? 0,
      different: row?.different ?? 0,
      questionsCovered: row?.covered ?? 0,
      questionsRemaining: remaining,
      quarantined: row?.quarantined ?? 0,
    };
  } catch (err) {
    if (isMissingTable(err)) return empty;
    throw err;
  }
}

// --- inline generation -------------------------------------------------------

export type PairGenResult = {
  questionsProcessed: number;
  pairsInserted: number;
  skipped: number;
  model: string;
};

// One generation pass in-process, mirroring the shadow judge's shape: a bounded
// number of SEQUENTIAL LLM calls inside one request, so a caller that omits
// `limit` can't fan out past a serverless wall-clock and 504 mid-loop, leaving
// half the bank generated. The batch path (Settings → Savings → Batch API) is
// where a whole-bank run belongs; this is the "try it now" path.
const GEN_DEFAULT_LIMIT = 25;
const GEN_MAX_LIMIT = 200;

// One pass at a time per process — two concurrent runs would generate the same
// questions twice and pay twice. In-memory, sufficient for a single-process app
// (a multi-instance deploy would need an advisory lock), same as the judge's.
let generating = false;

export class PairGenAlreadyRunningError extends Error {
  constructor() {
    super("A pair-generation run is already in progress.");
    this.name = "PairGenAlreadyRunningError";
  }
}

export async function generatePairs(opts: { limit?: number } = {}): Promise<PairGenResult> {
  if (generating) throw new PairGenAlreadyRunningError();
  generating = true;
  try {
    const model = config.semanticCache.keyModelSweep.generateModel;
    const counts = config.semanticCache.keyModelSweep.pairsPerQuestion;
    const limit = Math.min(opts.limit ?? GEN_DEFAULT_LIMIT, GEN_MAX_LIMIT);
    const gaps = await questionsNeedingPairs(limit);

    let pairsInserted = 0;
    let skipped = 0;
    for (const gap of gaps) {
      try {
        const resp = await meteredMessage(
          "cache_pairs",
          pairRequestParams(gap.question, gap.expectedAnswer, counts, model),
        );
        const pairs = pairsFrom(gap.question, parsePairs(resp));
        if (pairs.length === 0) {
          skipped++;
          continue;
        }
        pairsInserted += await insertPairs(gap.questionId, pairs, model);
      } catch (err) {
        // One bad question must not abandon the rest — it stays in the gap and
        // the next pass retries it.
        console.warn(`[rag:semantic-cache] pair generation failed: ${(err as Error).message}`);
        skipped++;
      }
    }
    return { questionsProcessed: gaps.length, pairsInserted, skipped, model };
  } finally {
    generating = false;
  }
}
