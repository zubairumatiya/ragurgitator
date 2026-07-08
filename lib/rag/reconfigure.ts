// ---------------------------------------------------------------------------
// IN-PLACE CONFIG CHANGE (bulk actions → change base model / chunk size).
//
// Unlike the create dialog (which spawns a NEW config), this mutates the
// CURRENT config: update its settings row, re-chunk + re-embed its documents
// under the new settings, and REMAP the eval labels — each question's
// ground-truth chunk is re-pointed at the new chunk that best overlaps its old
// chunk's text, so the eval set survives the change (scores go stale until the
// next re-score).
//
// The remap works on character spans: a chunk's text is a contiguous slice of
// the stored document content, so old and new chunks can both be located with
// a sequential indexOf sweep and matched by maximal overlap. Documents without
// stored raw text (pre-0010 uploads) can't be re-embedded — they're left under
// the previous settings and reported.
//
// Also supports the DOCUMENT-scoped variant: with `documentId` set, nothing on
// the config row changes — instead every chunk of that document gets a
// per-chunk override (model / size / size+model), the same mechanism the
// autotuner and the per-chunk trial use.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { resolveConfig, withConfig, type ResolvedConfig } from "@/lib/rag/activeConfig";
import { chunkDocument } from "@/lib/rag/chunker";
import { updateConfigSettings } from "@/lib/rag/configStore";
import { isProviderAvailable, modelSpec } from "@/lib/rag/embeddingModels";
import { embedTexts } from "@/lib/rag/embeddings";
import {
  setChunkModelOverride,
  setChunkSizeModelOverride,
  setChunkSizeOverride,
} from "@/lib/rag/eval";
import type { IngestEvent, IngestResult } from "@/lib/rag/pipeline";
import {
  chunksTable,
  deleteEmbeddingRunFor,
  insertEmbeddingRunWithChunks,
  modelDimension,
} from "@/lib/rag/vectorStore";

export type ReconfigureChanges = {
  baseModel?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  topK?: number;
};

type Emit = (event: IngestEvent) => void;

// Char spans of a chunk list within its document content, via a sequential
// indexOf sweep (chunks are ordered, contiguous-ish slices; overlap means the
// next chunk starts after the previous one's start). -1 start = not locatable.
function chunkSpans(
  content: string,
  chunks: { text: string }[],
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const c of chunks) {
    const start = content.indexOf(c.text, cursor);
    if (start === -1) {
      spans.push({ start: -1, end: -1 });
      continue;
    }
    spans.push({ start, end: start + c.text.length });
    cursor = start + 1;
  }
  return spans;
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

// Validate that a base-model change targets an ingestable, available model.
// Throws with a user-facing message otherwise.
function assertUsableBaseModel(model: string): void {
  const spec = modelSpec(model); // throws on unknown
  chunksTable(model, modelDimension(model)); // throws when not ingestable
  if (!isProviderAvailable(spec.provider)) {
    throw new Error(`"${model}" isn't available — set its provider's API key.`);
  }
}

// Change the CURRENT config in place. Streams IngestEvents (the same shape as
// ingest/populate) so the dialog shows per-document progress. Returns the
// per-document results plus how many eval labels were remapped/dropped.
export async function reconfigureConfig(
  configId: string,
  changes: ReconfigureChanges,
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[]; remapped: number; dropped: number }> {
  const old = await resolveConfig(configId);
  if (!old) throw new Error("Config not found.");

  const needsReembed =
    (changes.baseModel !== undefined && changes.baseModel !== old.embeddingModel) ||
    (changes.chunkSize !== undefined && changes.chunkSize !== old.chunkSize) ||
    (changes.chunkOverlap !== undefined && changes.chunkOverlap !== old.chunkOverlap);

  if (changes.baseModel !== undefined) assertUsableBaseModel(changes.baseModel);

  // Settings-only change (top-k, or values equal to the current ones): update
  // the row and finish — nothing to re-embed.
  if (!needsReembed) {
    await updateConfigSettings(configId, changes);
    onEvent({ type: "start", total: 0 });
    onEvent({ type: "done", results: [] });
    return { results: [], remapped: 0, dropped: 0 };
  }

  // Snapshot what we need from the OLD world before anything is deleted.
  const docs = await sql<{ id: string; file_name: string; content: string | null }[]>`
    select d.id, d.file_name, d.content
    from documents d
    join document_embeddings de on de.document_id = d.id
    where de.config_id = ${old.id}
    order by de.created_at
  `;
  const labels = await sql<
    { eval_question_id: string; document_id: string; position: number; text: string }[]
  >`
    select l.eval_question_id, c.document_id, c.position, c.text
    from eval_labels l
    join document_embeddings de on de.id = l.document_embedding_id
    join ${sql(old.chunksTable)} c on c.id = l.source_chunk_id
    where de.config_id = ${old.id}
  `;

  await updateConfigSettings(configId, changes);
  const next = await resolveConfig(configId);
  if (!next) throw new Error("Config vanished during reconfigure.");

  console.log(
    `[rag:reconfigure] config=${configId.slice(0, 8)}: ${old.embeddingModel}/${old.chunkSize}/${old.chunkOverlap}` +
      ` → ${next.embeddingModel}/${next.chunkSize}/${next.chunkOverlap}` +
      ` (${docs.length} doc(s), ${labels.length} label(s))`,
  );
  onEvent({ type: "start", total: docs.length });

  const results: IngestResult[] = [];
  let remapped = 0;
  let dropped = 0;

  for (let index = 0; index < docs.length; index++) {
    const doc = docs[index];
    const fileName = doc.file_name;
    try {
      if (doc.content === null) {
        // Pre-0010 upload: no raw text to re-chunk. Its old run stays as-is
        // (invisible to retrieval if the model changed) rather than vanishing.
        results.push({
          fileName,
          error: "No stored text — left under the previous settings. Re-upload to migrate.",
        });
        onEvent({ type: "file-done", index, result: results[results.length - 1] });
        continue;
      }
      const content = doc.content;

      // Drop the old run (cascades old chunks + labels + overrides for this doc).
      await deleteEmbeddingRunFor({ id: old.id, chunksTable: old.chunksTable }, doc.id);

      // Re-chunk + re-embed under the NEW settings.
      onEvent({ type: "step", index, fileName, step: "chunk" });
      const chunks = await withConfig(next, () =>
        chunkDocument({ id: doc.id, text: content, metadata: { fileName } }),
      );
      onEvent({ type: "step", index, fileName, step: "embed" });
      const vectors = await withConfig(next, () =>
        embedTexts(chunks.map((c) => c.text)),
      );
      onEvent({ type: "step", index, fileName, step: "store" });
      await withConfig(next, () =>
        insertEmbeddingRunWithChunks({
          documentId: doc.id,
          chunks: chunks.map((c, i) => ({
            position: c.position,
            text: c.text,
            embedding: vectors[i],
          })),
        }),
      );

      // Remap this doc's labels onto the new chunks by maximal text overlap.
      const docLabels = labels.filter((l) => l.document_id === doc.id);
      if (docLabels.length > 0) {
        const newChunks = await sql<{ id: string; position: number; text: string }[]>`
          select c.id, c.position, c.text
          from ${sql(next.chunksTable)} c
          join document_embeddings de on de.id = c.document_embedding_id
          where de.config_id = ${next.id} and c.document_id = ${doc.id}
          order by c.position
        `;
        const [run] = await sql<{ id: string }[]>`
          select id from document_embeddings
          where config_id = ${next.id} and document_id = ${doc.id}
          limit 1
        `;
        const newSpans = chunkSpans(content, newChunks);
        for (const label of docLabels) {
          const start = content.indexOf(label.text);
          if (start === -1 || newChunks.length === 0 || !run) {
            dropped += 1;
            continue;
          }
          const oldSpan = { start, end: start + label.text.length };
          let bestIdx = -1;
          let bestOverlap = 0;
          for (let i = 0; i < newSpans.length; i++) {
            const o = overlap(oldSpan, newSpans[i]);
            if (o > bestOverlap) {
              bestOverlap = o;
              bestIdx = i;
            }
          }
          if (bestIdx === -1) {
            dropped += 1;
            continue;
          }
          await sql`
            insert into eval_labels (eval_question_id, document_embedding_id, source_chunk_id)
            values (${label.eval_question_id}, ${run.id}, ${newChunks[bestIdx].id})
            on conflict (eval_question_id, document_embedding_id) do nothing
          `;
          remapped += 1;
        }
      }

      results.push({ fileName, chunksAdded: chunks.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Re-embedding failed.";
      console.error(`[rag:reconfigure] failed for "${fileName}": ${error}`);
      results.push({ fileName, error });
    }
    onEvent({ type: "file-done", index, result: results[results.length - 1] });
  }

  console.log(
    `[rag:reconfigure] done: ${results.length} doc(s), labels remapped=${remapped} dropped=${dropped}`,
  );
  onEvent({ type: "done", results });
  return { results, remapped, dropped };
}

// Document-scoped variant: apply the change to ONE document as per-chunk
// overrides (model / size / size+model) under the config — the config row is
// untouched. Streams one file-done per chunk.
export async function reconfigureDocument(
  cfg: ResolvedConfig,
  documentId: string,
  changes: ReconfigureChanges,
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const wantsModel =
    changes.baseModel !== undefined && changes.baseModel !== cfg.embeddingModel;
  const wantsSize =
    changes.chunkSize !== undefined || changes.chunkOverlap !== undefined;
  if (!wantsModel && !wantsSize) {
    throw new Error(
      changes.baseModel !== undefined
        ? "That's already the config's base model — nothing to override."
        : "Nothing document-scoped to change — pick a model and/or chunk size.",
    );
  }
  const size = changes.chunkSize ?? cfg.chunkSize;
  const overlapTokens = changes.chunkOverlap ?? cfg.chunkOverlap;

  const chunks = await withConfig(cfg, async () => {
    return sql<{ id: string; position: number }[]>`
      select id, position from ${sql(cfg.chunksTable)}
      where config_id = ${cfg.id} and document_id = ${documentId}
      order by position
    `;
  });
  if (chunks.length === 0) {
    throw new Error("That document has no chunks under this config.");
  }

  onEvent({ type: "start", total: chunks.length });
  const results: IngestResult[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const fileName = `chunk #${chunk.position}`;
    try {
      const status = await withConfig(cfg, () =>
        wantsModel && wantsSize
          ? setChunkSizeModelOverride(chunk.id, size, overlapTokens, changes.baseModel!)
          : wantsModel
            ? setChunkModelOverride(chunk.id, changes.baseModel!)
            : setChunkSizeOverride(chunk.id, size, overlapTokens),
      );
      results.push(
        status === "ok"
          ? { fileName, chunksAdded: 1 }
          : { fileName, error: `Override failed (${status}).` },
      );
    } catch (err) {
      results.push({
        fileName,
        error: err instanceof Error ? err.message : "Override failed.",
      });
    }
    onEvent({ type: "file-done", index, result: results[results.length - 1] });
  }
  onEvent({ type: "done", results });
  return { results };
}
