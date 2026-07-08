// ---------------------------------------------------------------------------
// API route: POST /api/configs/[id]/reconfigure
//
// Change THIS config in place (bulk actions → change base model / chunk size —
// deliberately NOT a new config). Body:
//   { baseModel?, chunkSize?, chunkOverlap?, topK?, documentId? }
//
// Config-wide (no documentId): updates the config row, re-embeds its documents
// under the new settings, and remaps eval labels by text overlap (see
// lib/rag/reconfigure). Document-scoped (documentId set): applies the change to
// that document's chunks as per-chunk overrides; the config row is untouched.
//
// Streams IngestEvents as NDJSON so the dialog shows progress. Scoped to the
// config named in the path. `params` is a Promise in this Next.js version.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { ndjsonStream } from "@/lib/http/ndjson";
import { resolveConfig } from "@/lib/rag/activeConfig";
import type { IngestEvent } from "@/lib/rag/pipeline";
import { reconfigureConfig, reconfigureDocument } from "@/lib/rag/reconfigure";

const Body = z
  .object({
    baseModel: z.string().min(1).optional(),
    chunkSize: z.number().int().positive().optional(),
    chunkOverlap: z.number().int().min(0).optional(),
    topK: z.number().int().positive().optional(),
    documentId: z.uuid({ error: "`documentId` must be a uuid." }).optional(),
  })
  .refine(
    (d) =>
      d.baseModel !== undefined ||
      d.chunkSize !== undefined ||
      d.chunkOverlap !== undefined ||
      d.topK !== undefined,
    { error: "Nothing to change — send baseModel, chunkSize, chunkOverlap, or topK." },
  )
  .refine((d) => d.chunkSize === undefined || (d.chunkOverlap ?? 0) < d.chunkSize, {
    error: "Overlap must be smaller than chunk size.",
  });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cfg = await resolveConfig(id);
  if (!cfg) return Response.json({ error: "Config not found." }, { status: 404 });

  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { documentId, ...changes } = body.data;

  return ndjsonStream<IngestEvent>(async (send) => {
    try {
      if (documentId) {
        await reconfigureDocument(cfg, documentId, changes, send);
      } else {
        await reconfigureConfig(id, changes, send);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Reconfigure failed.";
      send({ type: "error", message });
    }
  });
}
