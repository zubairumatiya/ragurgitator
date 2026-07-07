// ---------------------------------------------------------------------------
// API route: GET/POST /api/corpora
//
// GET lists corpora with document counts for the config-creation corpus picker,
// the sidebar, and the corpora page — including how many docs have stored raw
// text (`embeddableCount`), so the picker can warn when spawning a config over
// a corpus whose docs predate raw-text storage (migration 0010) would yield an
// empty config. `?includeEmpty=1` also returns doc-less corpora (the corpora
// page / sidebar want a just-created empty corpus to show up).
//
// POST creates a new named corpus (the corpora page's "New corpus" form) —
// empty, or seeded from existing corpora via `fromCorpusIds` (their documents
// merged and de-duplicated by content hash; `dupes` in the response reports
// what was collapsed). Docs can also be added later on the corpus page or by
// a synced config's uploads.
//
// Both are global (not config-scoped), so no withRequestConfig.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import {
  addDocumentToCorpus,
  createCorpus,
  dedupCorporaDocuments,
  listCorpora,
} from "@/lib/rag/corpusStore";

export async function GET(request: Request) {
  try {
    const includeEmpty =
      new URL(request.url).searchParams.get("includeEmpty") === "1";
    const corpora = await listCorpora({ includeEmpty });
    return Response.json({ corpora });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list corpora.";
    return Response.json({ error: message }, { status: 500 });
  }
}

const CreateBody = z.object({
  name: requiredTrimmedString("Provide a corpus `name`."),
  fromCorpusIds: z.array(z.string().min(1)).optional(),
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, CreateBody);
  if (parsed.response) return parsed.response;

  try {
    const id = await createCorpus(parsed.data.name);
    const { docs, dupes } = await dedupCorporaDocuments(parsed.data.fromCorpusIds ?? []);
    for (const d of docs) await addDocumentToCorpus(id, d.id);
    return Response.json(
      { corpus: { id, name: parsed.data.name, docCount: docs.length }, dupes },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create corpus.";
    return Response.json({ error: message }, { status: 500 });
  }
}
