// ---------------------------------------------------------------------------
// API route: GET/POST /api/configs
//
// GET returns the tabs the ConfigTabs bar renders: `open` (current tabs, ordered)
// and `closed` (the reopen menu). POST creates a brand-new EMPTY config — a fresh
// corpus + a config seeded with the lib/config.ts defaults — for the "+" button,
// and returns it so the client can route to the new tab.
//
// These act ON the configs table itself rather than within one config's scope, so
// they don't use withRequestConfig (configStore takes explicit ids). Body for
// POST is optional: { name?: string }.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { invalidBody, readJsonBody } from "@/lib/http/body";
import {
  createConfigWithSettings,
  createEmptyConfig,
  listClosedConfigs,
  listConfigs,
} from "@/lib/rag/configStore";
import { listBaseModelOptions } from "@/lib/rag/embeddingModels";

export async function GET() {
  try {
    const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
    return Response.json({ open, closed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list configs.";
    return Response.json({ error: message }, { status: 500 });
  }
}

// Config creation with settings: seed the config from 0..n source corpora
// (their docs de-duped by content hash), optionally saving the selection as a
// NEW corpus and/or enabling corpus auto-sync (0017). With no settings (just an
// optional name, or nothing) fall back to the "+" empty, corpus-less config.
const CreateBody = z
  .object({
    name: z.string().optional(),
    corpusIds: z.array(z.string().min(1)).default([]),
    saveAsCorpus: z
      .object({ name: z.string({ error: "Provide a corpus `name`." }) })
      .nullish(),
    sync: z.boolean().optional(),
    baseModel: z.string({ error: "Provide a `baseModel`." }).min(1, { error: "Provide a `baseModel`." }),
    chunkSize: z.number().int().min(1, { error: "`chunkSize` must be ≥ 1." }),
    chunkOverlap: z.number().int().min(0, { error: "`chunkOverlap` must be ≥ 0." }),
    topK: z.number().int().min(1, { error: "`topK` must be ≥ 1." }),
  })
  .refine((b) => b.chunkOverlap < b.chunkSize, {
    error: "`chunkOverlap` must be smaller than `chunkSize`.",
    path: ["chunkOverlap"],
  })
  .refine((b) => !b.sync || b.corpusIds.length === 1 || Boolean(b.saveAsCorpus), {
    error:
      "Auto-sync needs one target corpus — select a single corpus or save the selection as a new one.",
    path: ["sync"],
  });

export async function POST(request: Request) {
  const raw = await readJsonBody(request);
  const hasSettings =
    raw.data !== null &&
    typeof raw.data === "object" &&
    "baseModel" in (raw.data as Record<string, unknown>);

  try {
    // No settings → the simple "+" empty config (optional name).
    if (!hasSettings) {
      const name =
        raw.data && typeof (raw.data as { name?: unknown }).name === "string"
          ? ((raw.data as { name: string }).name)
          : undefined;
      const created = await createEmptyConfig(name);
      return Response.json({ config: created }, { status: 201 });
    }

    const parsed = CreateBody.safeParse(raw.data);
    if (!parsed.success) return invalidBody(parsed.error);
    const body = parsed.data;

    // The base model must actually be ingestable AND available right now (has a
    // vector table + a key / local) — re-check server-side so a stale/forged
    // selection can't create an unusable config.
    const option = listBaseModelOptions().find((o) => o.id === body.baseModel);
    if (!option || !option.selectable) {
      return Response.json(
        { error: option?.reason ?? `"${body.baseModel}" isn't a selectable base model.` },
        { status: 400 },
      );
    }

    const created = await createConfigWithSettings({
      name: body.name,
      corpusIds: body.corpusIds,
      saveAsCorpus: body.saveAsCorpus,
      sync: body.sync,
      baseModel: body.baseModel,
      chunkSize: body.chunkSize,
      chunkOverlap: body.chunkOverlap,
      topK: body.topK,
    });
    // `spawned` tells the client whether to run the populate (stream) step —
    // only a selection with source corpora has docs to embed.
    return Response.json(
      { config: created, spawned: body.corpusIds.length > 0 },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create config.";
    return Response.json({ error: message }, { status: 500 });
  }
}
