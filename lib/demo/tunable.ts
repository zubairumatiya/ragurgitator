// --- THE TUNABLE SET ----------------------------------------------------------
//
// Which questions get a graded-nDCG drilldown in the published demo, and which
// ones a visitor may re-score and autotune. Thirty of them since §2 of the
// real-flow plan; twelve before that, and the codebase still calls them "the
// twelve" in a good many comments this phase did not go and rewrite.
//
// SELECTED BY QUERY, NOT BY HAND, so a re-publish after the master has moved
// re-rolls the set against the corpus as it now scores rather than pinning uuids
// that quietly stopped being interesting. The trade is that a re-publish can
// silently produce a duller set, which is what demo-snapshot's assertSpread is for.
//
// IN lib/ RATHER THAN IN THE PUBLISH SCRIPT because two scripts now need the same
// set and they must not disagree: demo-snapshot.ts freezes everything else
// around it, and demo-warm-answers.ts buys the answers that make it usable
// without a key. A second hand-rolled copy of this query is how those two would
// drift apart on the next quota edit.
import "server-only";

import { privilegedSql } from "@/lib/db";
import { resolveKeyModel } from "@/lib/rag/semanticCache";
import { answerFingerprint } from "@/lib/rag/semanticCacheCore";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

// THE COMPOSITION IS THE WHOLE POINT. Autotune only has work to do on questions
// that are FAILING: a board of rank-1 hits gives the demo's most interesting
// button nothing to search for. So the quota is weighted at the hard tail.
//
// WIDENED TO THIRTY (§2). The ceiling is not the raw distribution but what
// survives ONE-QUESTION-PER-CHUNK, which is the smaller number and the one that
// decides whether a quota can be filled. Measured on the master's published
// config 2026-08-29, after the per-chunk dedupe: 175 at rank 1, 32 at 2, 7 at 3,
// 7 at 4, 15 missed. So the tail quotas below deliberately stop short of
// exhausting their tiers — take all 7 rank-4s and the next re-publish, after the
// master has moved by one question, comes up short and the build fails.
//
// A few comfortable questions are in the set deliberately — a drilldown showing
// what a rank-1 ideal ordering looks like is what makes the failures legible as
// failures.
export const QUOTAS: { tier: number; n: number; label: string }[] = [
  { tier: 99, n: 10, label: "missed" }, // 99 = not found in the top k
  { tier: 4, n: 6, label: "rank 4" },
  { tier: 3, n: 6, label: "rank 3" },
  { tier: 2, n: 4, label: "rank 2" },
  { tier: 1, n: 4, label: "rank 1" },
];

export type Tunable = { id: string; tier: number; chunk: string; document: string };

// ONE QUESTION PER SOURCE CHUNK. Autotune reshapes CHUNKS, so a dozen questions
// hanging off one chunk is one candidate search wearing a dozen hats — the plan's
// "several distinct chunks" requirement, enforced rather than hoped for.
//
// Ordered by md5(id) inside every bucket, not by id or created_at: those correlate
// with ingest order, which correlates with document, and the top of the list would
// be four questions from whichever file was uploaded first. md5 is stable, so the
// same corpus re-rolls the same set.
export async function selectTunable(configId: string): Promise<Tunable[]> {
  // The quota table, inlined as a CASE rather than joined in as a VALUES list, so
  // QUOTAS above stays the single place the composition is written down.
  const quotaCase =
    QUOTAS.map((q) => `when ${q.tier} then ${q.n}`).join(" ") + " else 0";
  return privilegedSql.unsafe<Tunable[]>(
    `with latest as (
       select distinct on (r.eval_label_id, r.k)
              r.eval_question_id as id,
              coalesce(r.found_rank, 99) as tier,
              l.source_chunk_id::text as chunk,
              q.document_id::text as document
         from eval_results r
         join eval_labels l on l.id = r.eval_label_id
         join document_embeddings de on de.id = l.document_embedding_id
         join eval_questions q on q.id = r.eval_question_id
        where de.config_id = $1
          and r.retrieval_state = 'baseline' and not r.is_baseline
          -- Ungradable without one: this selection decides which truth rows get
          -- cloned, and a question with none cannot supply one.
          and exists (select 1 from eval_rankings er
                       join document_embeddings de2 on de2.id = er.document_embedding_id
                      where er.eval_question_id = q.id and er.is_truth
                        and de2.config_id = $1)
          -- Ignored on the master (0014), holdout rows (0061) included: the
          -- operator took these out of the live aggregate, so they are not the
          -- questions to hand a visitor.
          and not exists (select 1 from config_question_ignores i
                           where i.config_id = $1 and i.eval_question_id = q.id)
        order by r.eval_label_id, r.k, r.scored_at desc
     ),
     per_chunk as (
       select distinct on (chunk) * from latest order by chunk, md5(id::text)
     ),
     ranked as (
       select *, row_number() over (partition by tier order by md5(id::text)) as rn
         from per_chunk
     )
     select id::text as id, tier::int as tier, chunk, document
       from ranked
      where rn <= case tier ${quotaCase} end
      order by tier desc, md5(id::text)`,
    [configId] as never[],
  );
}

// --- CAN THE PUBLISHED DEMO ACTUALLY ANSWER THE SET? --------------------------
//
// These are the only questions a guest may re-score and autotune, so they are
// what the demo steers visitors towards. A guest holds a Voyage key and nothing
// else, so a question with no banked answer is a DEAD END: /api/chat reaches
// generation, finds no answer-model key, and returns DEMO_BLOCKED.
//
// Nothing reported this. The publish counts cached answers in TOTAL — 252 of them,
// which reads as plenty — while the specific ones that matter go uncovered. The
// state this census was written for was 5 of 12 banked and 7 dead.
//
// The four columns below are semanticCacheLookup's WHERE clause, and matching it
// exactly is the only way the count is worth anything: a looser filter counts rows
// the probe cannot reach and reports a build that is fine when it is not — the
// failure mode verifyFingerprints exists for, one table over.
export type TunableCacheKey = {
  userId: string;
  keyModel: string;
  llmModel: string;
  fingerprint: string;
};

// The fingerprint is recomputed from the chunk rows rather than read off an
// existing cache row, for the same reason verifyFingerprints recomputes it: the
// question is whether answers are reachable from the config AS IT STANDS NOW, and
// a fingerprint copied out of a stale row would answer a different question.
//
// Returns null for a base model with no chunk table: there are no documents to
// sign and therefore no reachable answers at all.
export async function tunableCacheKey(configId: string): Promise<TunableCacheKey | null> {
  const [cfg] = await privilegedSql<
    {
      user_id: string;
      base_model: string;
      llm_model: string;
      cascade_enabled: boolean;
      key_model: string | null;
    }[]
  >`
    select user_id, base_model, llm_model, cascade_enabled,
           batch_savings -> 'semanticCache' ->> 'keyModel' as key_model
      from configs where id = ${configId}
  `;
  if (!cfg) throw new Error(`config ${configId} not found`);

  let table: string;
  try {
    table = chunksTable(cfg.base_model, modelDimension(cfg.base_model));
  } catch {
    return null;
  }
  const [sig] = await privilegedSql.unsafe<{ docs: string }[]>(
    `select coalesce(md5(string_agg(distinct document_id::text, ',' order by document_id::text)),
                     'empty') as docs
       from "${table}" where config_id = $1`,
    [configId] as never[],
  );
  return {
    userId: cfg.user_id,
    keyModel: resolveKeyModel(cfg.key_model),
    llmModel: cfg.llm_model,
    fingerprint: answerFingerprint({
      cascadeEnabled: cfg.cascade_enabled,
      documents: sig.docs,
    }),
  };
}

export type TunableAnswer = Tunable & { question: string; cached: boolean };

// `cached` is EXACT-match only — the query_hash the store writes, sha256 of the
// question text. The lookup would also serve one of these from a near neighbour
// above τ, so a false "uncached" here is possible; it is the right way round.
// Buying an answer that a paraphrase would have covered costs a cent; shipping a
// build whose headline questions dead-end costs the demo.
export async function tunableAnswerCensus(
  configId: string,
  tunable: Tunable[],
): Promise<TunableAnswer[]> {
  if (tunable.length === 0) return [];
  const key = await tunableCacheKey(configId);

  return privilegedSql<TunableAnswer[]>`
    select q.id::text as id, q.question,
           x.tier::int as tier, x.chunk, x.document,
           -- A null key (no chunk table for this base model) makes every
           -- comparison null and so the exists false, which is the right answer:
           -- nothing is reachable.
           exists (
             select 1 from semantic_cache s
              where s.user_id = ${key?.userId ?? null}
                and s.embedding_model = ${key?.keyModel ?? null}
                and s.llm_model = ${key?.llmModel ?? null}
                and s.fingerprint = ${key?.fingerprint ?? null}
                and s.query_hash = encode(sha256(convert_to(q.question, 'UTF8')), 'hex')
           ) as cached
      from unnest(
             ${tunable.map((t) => t.id)}::uuid[],
             ${tunable.map((t) => t.tier)}::int[],
             ${tunable.map((t) => t.chunk)}::text[],
             ${tunable.map((t) => t.document)}::text[]
           ) as x(id, tier, chunk, document)
      join eval_questions q on q.id = x.id
     order by cached, x.tier desc
  `;
}
