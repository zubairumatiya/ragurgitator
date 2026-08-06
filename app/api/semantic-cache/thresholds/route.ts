// ---------------------------------------------------------------------------
// API route: GET/POST /api/semantic-cache/thresholds
//
// GET  — per vector-space calibrated threshold (or the default) plus cache and
//        shadow-log stats, across every config. Backs the Thresholds panel on
//        Appraise → Semantic caching.
// POST — apply/set a space's threshold `{space, threshold, sampleSize?, notes?}`
//        (the "Apply recommended" / "Apply calibrated" buttons).
//
// Not config-scoped: a threshold is keyed by vector-space, shared by every
// config of YOURS that uses that embedding model. Since 0050 the table is
// primary-keyed (user_id, space), so it stops there — one account's calibration
// no longer governs another's cache, which mattered because a threshold set too
// low makes the cache serve WRONG ANSWERS.
// ---------------------------------------------------------------------------
import { z } from "zod";

import { withRequestUser } from "@/lib/http/configScope";
import { parseBody } from "@/lib/http/body";
import { applyThreshold, listThresholdsWithStats } from "@/lib/rag/semanticCacheCalibration";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET() {
  return withRequestUser(async () => {
    try {
      return Response.json({ thresholds: await listThresholdsWithStats() });
    } catch (err) {
      return Response.json({ error: msg(err, "Failed to load thresholds.") }, { status: 500 });
    }
  });
}

const Body = z.object({
  space: z.string().min(1),
  threshold: z.number().min(0).max(1),
  sampleSize: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, Body);
  if (parsed.response) return parsed.response;
  return withRequestUser(async () => {
    try {
      await applyThreshold(
        parsed.data.space,
        parsed.data.threshold,
        parsed.data.sampleSize ?? null,
        parsed.data.notes ?? "manual",
      );
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ error: msg(err, "Failed to apply threshold.") }, { status: 500 });
    }
  });
}
