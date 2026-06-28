// ---------------------------------------------------------------------------
// API route: GET /api/corpora
//
// Lists corpora with document counts for the config-creation corpus picker —
// including how many docs have stored raw text (`embeddableCount`), so the picker
// can warn when spawning a config over a corpus whose docs predate raw-text
// storage (migration 0010) would yield an empty config. Global (not config-
// scoped), so no withRequestConfig.
// ---------------------------------------------------------------------------
import { listCorpora } from "@/lib/rag/corpusStore";

export async function GET() {
  try {
    const corpora = await listCorpora();
    return Response.json({ corpora });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list corpora.";
    return Response.json({ error: message }, { status: 500 });
  }
}
