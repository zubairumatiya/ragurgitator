// PROBE REPLAY — stock §3's Accept/Reject queue from generated pairs instead of
// waiting for traffic (docs/probe-replay-plan.md).
//
// The shadow judge panel on /appraise/semantic-cache only ever sees rows the LIVE
// lookup wrote, and the live lookup only ever writes `origin: 'traffic'`. So the
// calibration curve stays flat until the account has asked enough questions to
// produce a genuinely BAD near-match — which on this account took months and still
// came out one-class (F7: 91 judged, 91 accepted, 0 rejects). The probe rows that
// give the demo its curve came from scripts/f1-negatives.ts and scripts/f2-floor.ts,
// driven by hand. This module is that pass, promoted into the product.
//
// TWO RULES, both load-bearing:
//
//   1. NO VERDICTS ARE WRITTEN. Probe rows land with verdict = null: they stock the
//      QUEUE, not the curve. Copying expectedVerdict(label) across from the pair
//      table would give an instant curve and would be wrong — F3 measured the
//      generator's hard-negative labels at 80% correct, and §3's τ becomes a live
//      serving threshold via ApplyThresholdPanel. An unaudited label must not get
//      to change what the cache serves. The LLM judge already sits on that panel,
//      already gated and metered; that is where the shortcut belongs, because it is
//      the place that reports its cost.
//
//   2. NOTHING IS EVER BANKED. semanticCacheLookup(serve: false) returns a miss and
//      the caller does not store, so a probe leaves semantic_cache untouched. A pass
//      that banked its own variants would let the next one self-match at cosine 1.0
//      — the Phase 8 trap, restated at f1-negatives.ts:25.
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { fragment, sql } from "@/lib/db";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { activeConfig } from "@/lib/rag/activeConfig";
import { PROBE_LOOKUP, type ProbePair } from "@/lib/rag/probeReplayCore";
import {
  currentFingerprint,
  resolveKeyModel,
  semanticCacheLookup,
} from "@/lib/rag/semanticCache";
import { variantOf, type PairDifficulty } from "@/lib/rag/semanticCachePairs";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// THE QUARANTINE PREDICATE, and it is deliberately the SAME expression listPairs
// and quarantinedPairs filter on (semanticCachePairs.ts:255, :299) rather than a
// second reading of (verdict, label): a probe path that disagreed with the sweep
// about which pairs are audited-wrong would put F3's 15 disproved rows into §3's
// queue while the leaderboard excluded them, and nothing would look broken.
//
// Read as a COLUMN, not a WHERE clause, because the bulk job and the guest's
// single probe want different things from it — the job replays whatever is
// eligible (its rows are dropped by poolPairs downstream anyway), while
// docs/demo-cache-lab-plan.md Phase 4 refuses to probe a quarantined pair at all.
// One query, one flag, two policies applied in the pure core.
const QUARANTINED = fragment`(
  p.verdict is not null
  and p.verdict <> case when p.label = 'same' then 'accept' else 'reject' end
)`;

// The shape of a probe and the rule for choosing a capped sample of them live in
// the dependency-free core, so they can be tested without a database. Re-exported
// here because this module is the one callers reach for.
export {
  PROBE_CAP,
  QuarantinedProbeError,
  assertPoolSafe,
  poolSafeProbes,
  selectOneProbe,
  selectProbes,
  type ProbePair,
} from "@/lib/rag/probeReplayCore";

// The core restates the generator's difficulty labels rather than importing them —
// it imports nothing, by design. The two are held in agreement by the queries below,
// which read a `PairDifficulty` column straight into a ProbePair: add a third label
// to PairDifficulty and those assignments stop compiling.

// Why the VARIANT and not both orientations, which the plan left open:
//
// insertPairs canonicalises text_a/text_b by hash, so the stored orientation says
// nothing — but the pair is not symmetric in the way that matters here. Eligibility
// requires the ORIGIN to be banked in semantic_cache; replaying the origin's own
// text therefore lands on ITSELF at cosine 1.0 and measures nothing. Only the
// variant is a near-miss, and (origin banked, variant probing) is also the exact
// direction the live serving path runs in — which the order-sensitive entity guard
// (F6) cares about. So: one probe per pair, always the variant.
//
// This is why the roles are resolved through variantOf against eval_questions
// rather than assuming text_a is the origin — F3 established that it is not.

// --- eligibility -------------------------------------------------------------

// Pairs whose origin question is banked under ALL FOUR of the lookup's WHERE-clause
// columns — user, cache-key model, answering model, fingerprint — and whose variant
// has no shadow row yet.
//
// All four, because a lookup scoped by fewer would count a row it cannot reach: the
// candidate set semanticCacheLookup scans is exactly
// (user_id, embedding_model, llm_model, fingerprint). Counting on the text alone
// overstates eligibility, which is why the plan's 186 was labelled an upper bound.
//
// The banked-ness test is SQL-side (encode(sha256(...)) matches semantic_cache's
// query_hash, itself a utf8 sha256 hex) so no question text crosses the wire to be
// hashed in JS, and no vectors are touched at all.
export async function eligiblePairs(limit = 500): Promise<ProbePair[]> {
  const cfg = activeConfig();
  const keyModel = resolveKeyModel(null);

  try {
    const fingerprint = await currentFingerprint(cfg);

    const rows = await sql<
      {
        id: string;
        text_a: string;
        text_b: string;
        difficulty: PairDifficulty;
        question_id: string;
        question: string;
        quarantined: boolean;
      }[]
    >`
      select p.id, p.text_a, p.text_b, p.difficulty, q.id as question_id, q.question,
             ${QUARANTINED} as quarantined
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
      where d.user_id = ${activeUserId()}
        and exists (
          select 1 from semantic_cache sc
          where sc.user_id = ${activeUserId()}
            and sc.embedding_model = ${keyModel}
            and sc.llm_model = ${cfg.llmModel}
            and sc.fingerprint = ${fingerprint}
            and sc.query_hash = encode(sha256(q.question::bytea), 'hex')
        )
      order by p.id
      limit ${limit}
    `;

    // Already-probed variants drop out here rather than in SQL: the hash is over the
    // VARIANT, and which of text_a/text_b that is takes variantOf to decide. Keyed on
    // (config_id, fingerprint, new_query_hash) — recordShadow's on-conflict target
    // exactly, so this check and the constraint cannot disagree.
    //
    // BOTH TABLES, because "recorded" and "attempted" stopped being the same thing
    // when the single-probe route (phase 4) raised its floor. A probe below
    // shadowLogFloor writes no shadow row on purpose, so the shadow log alone
    // leaves it eligible and the next call re-selects it — and selectProbes is a
    // total order, so that is the same pair every time, forever. probe_attempts
    // (0079) is keyed identically and carries the attempts the floor swallowed.
    const probed = new Set(
      (
        await sql<{ new_query_hash: string }[]>`
          select new_query_hash from semantic_cache_shadow
          where config_id = ${cfg.id} and fingerprint = ${fingerprint}
          union
          select new_query_hash from probe_attempts
          where config_id = ${cfg.id} and fingerprint = ${fingerprint}
        `
      ).map((r) => r.new_query_hash),
    );

    return rows.flatMap((r) => {
      const variantText = variantOf(r.text_a, r.text_b, r.question);
      if (variantText === null) return [];
      if (probed.has(sha256(variantText))) return [];
      return [
        {
          pairId: r.id,
          originQuestionId: r.question_id,
          originText: r.question,
          variantText,
          difficulty: r.difficulty,
          quarantined: r.quarantined,
        },
      ];
    });
  } catch (err) {
    // Best-effort like the rest of the cache: an account without 0040/0035 applied
    // simply has nothing to replay.
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// --- resolving a frozen sample -----------------------------------------------

// Resolve frozen pair ids back to probeable pairs, WITHOUT the eligibility filter.
//
// The filter is deliberately absent: a job's sample is chosen once, and re-deciding
// eligibility mid-run would silently swap in pairs the run never planned for. A
// pair that has become unreachable since (an ingest rotated the fingerprint) simply
// records nothing when replayed — the same outcome F1 called a dead origin — and
// one already probed by someone else dedupes on recordShadow's conflict key.
export async function probePairsByIds(ids: string[]): Promise<ProbePair[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await sql<
      {
        id: string;
        text_a: string;
        text_b: string;
        difficulty: PairDifficulty;
        question_id: string;
        question: string;
        quarantined: boolean;
      }[]
    >`
      select p.id, p.text_a, p.text_b, p.difficulty, q.id as question_id, q.question,
             ${QUARANTINED} as quarantined
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
      where d.user_id = ${activeUserId()} and p.id = any(${ids}::uuid[])
    `;
    const byId = new Map<string, ProbePair>();
    for (const r of rows) {
      const variantText = variantOf(r.text_a, r.text_b, r.question);
      if (variantText === null) continue;
      byId.set(r.id, {
        pairId: r.id,
        originQuestionId: r.question_id,
        originText: r.question,
        variantText,
        difficulty: r.difficulty,
        quarantined: r.quarantined,
      });
    }
    // Returned in the FROZEN order, not the database's: the cursor indexes into
    // this array, so its order is part of the resume contract.
    return ids.flatMap((id) => {
      const pair = byId.get(id);
      return pair ? [pair] : [];
    });
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// --- replay ------------------------------------------------------------------

export type ReplayResult = { probed: number; failed: number; stopped: boolean };

// Push each variant through the REAL lookup with serving off. One
// embedQueryCached per distinct variant text (content-addressed, so a re-run of
// the same text is free) plus one indexed single-row SQL match; no vectors cross
// the wire, since the nearest-match sort has been SQL-side since the egress work.
//
// A caller MUST NOT describe the resulting shadow row as "this pair, replayed".
// Eligibility guarantees the origin is REACHABLE, not that it is the nearest — a
// third banked question can win. That row is still honest (it is what the cache
// would have done for that query, which is what §3 measures) but it is no longer
// about the pair, and labelling it as such in the UI would be the F1 dead-origin
// mistake with a friendlier face.
export async function replayPairs(
  pairs: ProbePair[],
  shouldStop: ShouldStop = NEVER_STOP,
  // Called once per ATTEMPTED probe, success or failure, with the running count of
  // attempts. The background step turns it into slice progress; a script can ignore
  // it. Attempts rather than successes because a failed probe still consumed its
  // place in a capped run — see the step's cursor.
  onProgress: (attempted: number, failure?: string) => void = () => {},
  // The shadow-log floor these probes record at, defaulted to PROBE_LOOKUP's own
  // 0 so every existing caller behaves EXACTLY as before — a research pass chooses
  // its own floor and "below the floor" is meaningless for it (F2).
  //
  // A parameter rather than a second function, because the alternative is two code
  // paths through the one call site scripts/guards.ts sweep 7 pins to PROBE_LOOKUP,
  // and the second one is where serve:true gets in. The guest's single probe
  // (docs/demo-cache-lab-plan.md Phase 4) passes config.semanticCache.shadowLogFloor
  // so its row lands in the same band as the clone's sample around it: a visitor
  // who judges a 0.4 near-miss nobody else in the queue could have produced is
  // judging an artefact of the demo, not of the cache.
  floor: number = PROBE_LOOKUP.shadow.floor,
): Promise<ReplayResult> {
  let probed = 0;
  let failed = 0;

  for (const pair of pairs) {
    // A FLAG, not a throw — cancellation is checked between probes and the loop
    // simply breaks, per the house rule.
    if (shouldStop()) return { probed, failed, stopped: true };
    try {
      // PROBE_LOOKUP, never an object literal: serve:false is the parameter whose
      // silent loss turns a calibration pass into a cache-poisoning pass, so it
      // is defined once in the pure core, asserted by a test, and pinned to this
      // call site by scripts/guards.ts sweep 7.
      // Spread rather than replaced: every other key here is a rail, and the
      // floor is the only one a caller may choose. Written inline so the guard's
      // "exactly one call site, and PROBE_LOOKUP appears in it" still reads the
      // real options — a helper returning the merged object would move the four
      // decisions out of the place the sweep looks.
      await semanticCacheLookup(pair.variantText, {
        ...PROBE_LOOKUP,
        shadow: { ...PROBE_LOOKUP.shadow, floor },
      });
      probed++;
      onProgress(probed + failed);
    } catch (err) {
      // One bad probe must not end the pass; the row simply stays unwritten and a
      // later top-up finds it eligible again.
      console.warn(
        `[rag:probe-replay] probe failed for pair ${pair.pairId}: ${(err as Error).message}`,
      );
      failed++;
      onProgress(
        probed + failed,
        err instanceof Error ? err.message : "Probe failed.",
      );
    }
  }

  return { probed, failed, stopped: false };
}

// --- reading a probe back ----------------------------------------------------

// The shadow row a probe just wrote, or null when it wrote none.
//
// Keyed on (config_id, fingerprint, new_query_hash) — recordShadow's on-conflict
// target, the same key eligiblePairs dedupes against, so this cannot disagree
// with either about which row belongs to which variant.
//
// NULL MEANS BELOW THE FLOOR, and that is a real answer rather than a failure:
// eligibility already proved the origin is banked and reachable, so there was a
// nearest match — it simply did not clear the floor the caller chose. A UI may
// say so plainly (docs/demo-cache-lab-plan.md, Phase 4). It must NOT say "this
// pair, replayed": the nearest match is not guaranteed to be the origin, which is
// the F1 dead-origin mistake replayPairs' own comment warns about.
//
// Two columns, both original to 0035. `origin` and `guard_blocked` are in
// SHADOW_OPTIONAL_COLUMNS (semanticCache.ts:594) precisely because a deployment
// can run ahead of its migrations, and selecting one of those here would turn
// that tolerated state into a 42703 on the guest's probe.
export type ProbeRow = { sim: number; matchedQuery: string };

export async function probeRow(variantText: string): Promise<ProbeRow | null> {
  const cfg = activeConfig();
  try {
    const fingerprint = await currentFingerprint(cfg);
    const [row] = await sql<{ sim: number; matched_query: string }[]>`
      select sim, matched_query
        from semantic_cache_shadow
       where config_id = ${cfg.id}
         and fingerprint = ${fingerprint}
         and new_query_hash = ${sha256(variantText)}
    `;
    return row
      ? { sim: Number(row.sim), matchedQuery: row.matched_query }
      : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// Remember that this variant was probed, whatever the lookup made of it.
//
// WHY IT IS NOT CONDITIONAL ON THE PROBE HAVING QUEUED. The below-floor case is
// the only one that needs remembering — a probe that recorded a shadow row is
// already excluded by eligiblePairs' first arm — but writing unconditionally is
// what keeps the two arms from disagreeing. A caller that recorded the attempt
// only on the miss would have to reproduce the floor test, and a floor test in
// two places is a floor test that eventually differs from itself.
//
// IDEMPOTENT on 0079's primary key, which is recordShadow's on-conflict target,
// so a re-probe of the same variant under the same index updates nothing and
// raises nothing.
//
// BEST-EFFORT for the reason probeRow is: a deployment can run ahead of its
// migrations, and a missing table here must cost a visitor a repeated pair
// rather than fail a probe that already spent its embedding.
export async function recordProbeAttempt(variantText: string): Promise<void> {
  const cfg = activeConfig();
  try {
    const fingerprint = await currentFingerprint(cfg);
    await sql`
      insert into probe_attempts (config_id, fingerprint, new_query_hash)
      values (${cfg.id}, ${fingerprint}, ${sha256(variantText)})
      on conflict do nothing
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}
