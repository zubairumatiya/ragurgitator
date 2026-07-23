// ---------------------------------------------------------------------------
// API route: GET /api/semantic-cache/shadow
//
// Returns the shadow-log spaces (for the space picker) and, when ?space=… is
// given, that space's events for the human queue / inspection. Optional
// ?filter=unjudged|judged|all and ?limit=. Global (shadow events are pooled per
// vector-space across configs, matching the thresholds table).
// ---------------------------------------------------------------------------
import { listShadowEvents, listShadowSpaces } from "@/lib/rag/semanticCacheCalibration";

const FILTERS = new Set(["unjudged", "judged", "all"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const space = url.searchParams.get("space");
  const rawFilter = url.searchParams.get("filter");
  const filter = rawFilter && FILTERS.has(rawFilter) ? (rawFilter as "unjudged" | "judged" | "all") : "all";
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    const spaces = await listShadowSpaces();
    const events = space ? await listShadowEvents({ space, filter, limit }) : [];
    return Response.json({ spaces, events });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load shadow log.";
    return Response.json({ error: message }, { status: 500 });
  }
}
