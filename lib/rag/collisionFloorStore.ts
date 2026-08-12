// DB layer for the SAVED COLLISION-FLOOR REPORT (migration 0037).
//
// The collision floor is an all-pairs sweep over a config's labeled eval
// questions (semanticCacheCalibration.computeCollisionFloor). It used to live
// only in the panel's React state, so leaving Appraise → Semantic caching and
// coming back meant re-running it to see a number that hadn't changed. This
// module persists the latest report per config and reads it back.
//
// Cache semantics, NOT a source of truth: nothing is ever served from a saved
// report. It's a display + "offer this recommendation to the apply panel"
// convenience, and the real number is always recomputable by pressing Recompute.
// That's what licenses the best-effort contract below.
//
// Best-effort exactly like savingsStore / semanticCache: a missing table (42P01,
// i.e. 0037 not applied) makes the read return null and the write no-op, so the
// app behaves IDENTICALLY with or without the migration. A save failure must
// never cost the caller the report it just computed, so writes swallow other
// errors too (warn only) — the caller has the value in hand and returns it
// regardless.
//
// Deliberately separate from semanticCacheCalibration.ts, which owns the
// computation: persistence is a different concern and the calibration module is
// imported by paths that must not care whether 0037 exists.
import { isolated, sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { CollisionFloorReport } from "@/lib/rag/semanticCacheCalibration";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// A saved report plus when it was produced. `report` is byte-for-byte the shape
// a fresh compute returns, so the panel renders both through one code path.
export type SavedCollisionFloor = {
  report: CollisionFloorReport;
  computedAt: string; // ISO
};

type Row = {
  space: string;
  embedding_model: string;
  floor: number | null;
  same_answer_min: number | null;
  same_answer_median: number | null;
  recommended: number | null;
  distinct_pairs: number;
  same_answer_pairs: number;
  questions_used: number;
  questions_total: number;
  overlap: boolean;
  computed_at: Date;
};

// Everything below runs inside a withRequestConfig scope (the route wraps both
// handlers), so the config comes from activeConfig() rather than a parameter —
// same convention as the calibration it caches.

// The latest saved report for the active config, or null when nothing has been
// computed yet (or 0037 hasn't been applied — indistinguishable to the caller,
// and correctly so: both mean "no saved report to show").
export async function getSavedCollisionFloor(): Promise<SavedCollisionFloor | null> {
  try {
    const rows = await sql<Row[]>`
      select space, embedding_model, floor, same_answer_min, same_answer_median,
             recommended, distinct_pairs, same_answer_pairs, questions_used,
             questions_total, overlap, computed_at
      from semantic_cache_collision_floor
      where config_id = ${activeConfig().id}
    `;
    const r = rows[0];
    if (!r) return null;
    // float4 columns come back as JS numbers; the nullable four stay null.
    return {
      report: {
        space: r.space,
        embeddingModel: r.embedding_model,
        floor: r.floor,
        sameAnswerMin: r.same_answer_min,
        sameAnswerMedian: r.same_answer_median,
        recommended: r.recommended,
        distinctPairs: r.distinct_pairs,
        sameAnswerPairs: r.same_answer_pairs,
        questionsUsed: r.questions_used,
        questionsTotal: r.questions_total,
        overlap: r.overlap,
      },
      computedAt: r.computed_at.toISOString(),
    };
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// Everything the panel needs to paint a restored floor: the saved report, when
// it was computed, and the live labeled-question count its staleness hint
// compares against. Exactly the GET /collision-floor payload, because the two
// callers must not drift — the route serves it on a config switch, and the
// Semantic caching page reads it during the SERVER render so the panel's first
// paint already has the numbers instead of flashing empty (the client used to
// wait on /api/configs and only then ask for this).
export type CollisionFloorState = {
  report: CollisionFloorReport | null;
  computedAt: string | null;
  questionsNow: number | null;
};

export async function readCollisionFloorState(): Promise<CollisionFloorState> {
  const [saved, questionsNow] = await Promise.all([
    getSavedCollisionFloor(),
    countLabeledQuestions(),
  ]);
  return {
    report: saved?.report ?? null,
    computedAt: saved?.computedAt ?? null,
    questionsNow,
  };
}

// Upsert the active config's report (one row per config — a recompute replaces).
// Never throws: the caller has already paid for the computation and must be able
// to return it whether or not the save landed.
export async function saveCollisionFloor(report: CollisionFloorReport): Promise<void> {
  try {
    await isolated(
      () => sql`
      insert into semantic_cache_collision_floor (
        config_id, space, embedding_model, floor, same_answer_min,
        same_answer_median, recommended, distinct_pairs, same_answer_pairs,
        questions_used, questions_total, overlap, computed_at
      ) values (
        ${activeConfig().id}, ${report.space}, ${report.embeddingModel},
        ${report.floor}, ${report.sameAnswerMin}, ${report.sameAnswerMedian},
        ${report.recommended}, ${report.distinctPairs}, ${report.sameAnswerPairs},
        ${report.questionsUsed}, ${report.questionsTotal}, ${report.overlap}, now()
      )
      on conflict (config_id) do update set
        space              = excluded.space,
        embedding_model    = excluded.embedding_model,
        floor              = excluded.floor,
        same_answer_min    = excluded.same_answer_min,
        same_answer_median = excluded.same_answer_median,
        recommended        = excluded.recommended,
        distinct_pairs     = excluded.distinct_pairs,
        same_answer_pairs  = excluded.same_answer_pairs,
        questions_used     = excluded.questions_used,
        questions_total    = excluded.questions_total,
        overlap            = excluded.overlap,
        computed_at        = now()
    `,
    );
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[rag:collision-floor] save failed: ${(err as Error).message}`);
  }
}

// How many labeled questions the active config has RIGHT NOW — the staleness
// key for a saved report's questions_total.
//
// This is `count(distinct q.id)` over exactly the join evalStore
// .allLabeledQuestions uses, because that's what computeCollisionFloor counts
// into questionsTotal (it dedupes the one-row-per-label result down to unique
// question ids). Anything looser would flag stale on a config that hasn't
// changed. Counted in SQL rather than by re-reading the bank: the panel asks for
// this on every mount and it must not pull question text over the wire.
//
// Returns null if the count can't be taken, which the caller reads as "can't
// judge staleness" and shows no hint — never a false alarm.
export async function countLabeledQuestions(): Promise<number | null> {
  try {
    const rows = await isolated(
      () => sql<{ n: number }[]>`
        select count(distinct q.id)::int as n
        from eval_questions q
        join eval_labels l on l.eval_question_id = q.id
        join document_embeddings de on de.id = l.document_embedding_id
        where de.config_id = ${activeConfig().id}
      `,
    );
    return rows[0]?.n ?? null;
  } catch (err) {
    console.warn(`[rag:collision-floor] labeled-question count failed: ${(err as Error).message}`);
    return null;
  }
}
