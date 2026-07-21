// ---------------------------------------------------------------------------
// RESPONSE EFFICACY GATE  (FrugalGPT LLM-cascade scoring function)
//
// FrugalGPT (Chen, Zaharia & Zou, 2023) runs a chain of models cheapest → most
// expensive and, after each answer, a small SCORING FUNCTION decides accept vs.
// escalate. This module is that scoring function for our RAG flow. It is the
// primary Phase-E savings lever — see docs/long-term-savings-research.md §4.2.
//
// TWO DISTINCT DECISIONS ON TWO INDEPENDENT AXES (that doc's §4.1):
//
//   AXIS 1 — is there enough CONTEXT to answer at all?  Rung 1 (retrieval floor,
//     the top cosine already on each source). Known BEFORE generation. A weak
//     retrieval is a RETRIEVAL bottleneck — a stronger model can't invent context
//     that wasn't retrieved, so this must NEVER trigger LLM escalation. pipeline.ask
//     checks retrievalFloor() pre-generation and, when it's too low, answers once
//     with the cheap model and stops. This gate REPORTS the floor as a signal but
//     does not escalate on it. (Exported as retrievalFloor for that pre-gen check.)
//
//   AXIS 2 — did the model USE the context well?  Rungs 0+2, POST-generation, and
//     the ONLY escalation trigger:
//       Rung 0 — HEURISTICS: refusal/hedge detection + a minimum answer length.
//       Rung 2 — EMBEDDING GROUNDEDNESS: cosine(answer, chunk). retrieve() returns
//         chunks WITHOUT vectors (score + text only), so we embed the answer once
//         and read each chunk's stored base-space vector by id (chunkEmbeddings —
//         one DB read). Did the answer stay faithful to the context it was given
//         (RAG's core failure mode)?
//     A stronger model CAN fix an axis-2 miss (adequate context, cheap model
//     fumbled it), so score < threshold here means escalate.
//
// `score`/`verdict` are AXIS-2 ONLY. Conflating the axes — escalating on weak
// retrieval — pays strong-model prices to fail again on the same thin context,
// the exact mistake §4.1 warns against.
//
// Per-chunk overrides don't affect rung 2. cosine is only meaningful WITHIN one
// embedding space, so both sides are base-space: the answer is embedded under the
// config's base model, and chunkEmbeddings reads each chunk's BASE vector — every
// chunk keeps its base row, an override only ADDS a foreign-space representation
// used for retrieval ranking. We never mix the answer with an override's foreign
// vector (the cross-space error retriever.ts warns about). Caveat: for a chunk
// retrieved BECAUSE of its override space, its base vector is a consistent but
// possibly conservative view of the match.
//
// Thresholds live in config.cascade and are deliberately exposed: tuning
// `efficacyThreshold` against a labelled set is the "threshold sweep" — the same
// search-a-parameter-against-a-metric shape as lib/rag/autotune, but a sibling
// tuner (a scalar cutoff vs. autotune's size×model ladder), not that engine.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import { cosine, embedQueryCached } from "@/lib/rag/embedCache";
import { chunkEmbeddings } from "@/lib/rag/vectorStore";
import type { RetrievedChunk } from "@/types/rag";

export type EfficacyVerdict = "accept" | "escalate";

export type EfficacySignals = {
  refused: boolean; // rung 0: answer reads as a refusal / non-answer
  tooShort: boolean; // rung 0: answer below the minimum length
  retrievalFloor: number; // rung 1 (axis 1): reported only — NOT an escalation trigger
  groundedness: number; // rung 2 (axis 2): max cosine(answer, base-space chunk); 0 if refused/none
};

export type EfficacyResult = {
  score: number; // axis-2 composite in [0,1] (groundedness × length; 0 if refused)
  verdict: EfficacyVerdict; // accept the answer, or escalate to a stronger model
  signals: EfficacySignals; // raw rung outputs, for debugging and threshold tuning
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Rung 1 (axis 1): strongest retrieval signal we have — the max cosine already
// attached to each source by retrieve() (no embedding, no LLM). Exported so
// pipeline.ask can gate on it BEFORE generation; the gate itself only reports it.
export function retrievalFloor(sources: RetrievedChunk[]): number {
  let best = 0;
  for (const s of sources) if (s.score > best) best = s.score;
  return best;
}

// The generator's system prompt makes it decline with this exact phrase; the
// rest are conservative extras. A false positive only costs one escalation to
// the strong model (no wrong answer), so a slightly generous list is fine.
const REFUSAL_MARKERS = [
  "i don't know based on the provided documents",
  "i don't know based on the provided context",
  "the context does not contain",
  "not contain enough information",
  "no relevant information",
];

function isRefusal(answer: string): boolean {
  const a = answer.toLowerCase();
  return REFUSAL_MARKERS.some((m) => a.includes(m));
}

// Rung 2 (axis 2): embed the answer once; read each source chunk's stored
// base-space vector by id. Best (max) cosine = how well the answer is supported
// by its most-relevant context.
async function groundedness(
  answer: string,
  sources: RetrievedChunk[],
): Promise<number> {
  if (sources.length === 0) return 0;
  const [answerVec, vecs] = await Promise.all([
    embedQueryCached(answer, activeConfig().embeddingModel),
    chunkEmbeddings(sources.map((s) => s.chunk.chunk.id)),
  ]);
  let best = 0;
  for (const s of sources) {
    const v = vecs.get(s.chunk.chunk.id);
    if (!v) continue; // no base row for this id (rare) — can't score it
    const sim = cosine(answerVec, v);
    if (sim > best) best = sim;
  }
  return best;
}

// Score a generated answer on AXIS 2 and decide accept vs. escalate. Rung 1 is
// reported in `signals` but never drives the verdict — that's the pre-generation
// context check in pipeline.ask (see the module header).
//
// `_question` is part of the gate's contract (query, answer, sources) but isn't
// needed for the current rungs; it's reserved for a future answer-relevance axis
// (does the answer address the question, not just the context).
export async function responseEfficacyGate(
  _question: string,
  answer: string,
  sources: RetrievedChunk[],
): Promise<EfficacyResult> {
  const cfg = config.cascade;
  const trimmed = answer.trim();

  const refused = isRefusal(trimmed);
  const tooShort = trimmed.length < cfg.minAnswerChars;
  // Skip the embed call when the answer is already a refusal — nothing to ground.
  const ground = refused ? 0 : await groundedness(trimmed, sources);

  const signals: EfficacySignals = {
    refused,
    tooShort,
    retrievalFloor: retrievalFloor(sources),
    groundedness: ground,
  };

  // Refusal → escalate outright: the cheap model told us it couldn't answer.
  if (refused) return { score: 0, verdict: "escalate", signals };

  // Axis-2 score: groundedness normalized against its target, times the length
  // penalty. Retrieval does NOT enter here (see header).
  const groundComponent = clamp01(ground / cfg.groundednessTarget);
  const lengthPenalty = tooShort ? cfg.shortPenalty : 1;
  const score = groundComponent * lengthPenalty;

  return {
    score,
    verdict: score >= cfg.efficacyThreshold ? "accept" : "escalate",
    signals,
  };
}
