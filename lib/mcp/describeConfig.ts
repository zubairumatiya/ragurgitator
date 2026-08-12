// THE `describe_config` TOOL PAYLOAD.
//
// The one tool the MCP server exposes: read back everything the UI knows about a
// config — settings, corpus, overrides, savings, eval scores — as one structured
// object, so an agent can reason about a config without its user copying numbers
// out of four different pages by hand.
//
// It lives here rather than in app/api/mcp/route.ts because assembly and
// transport are separate concerns and only one of them is interesting. The route
// is auth plus wiring; this is the part with the domain in it.
//
// WHAT IS DELIBERATELY NOT IN THE PAYLOAD: chunk text, document contents, and
// embedding vectors. The tool describes CONFIGURATION, not corpus. That line is
// what makes a read-only grant defensible to the person approving it — "your
// agent can see how this is set up and what it cost" is a very different consent
// question from "your agent can read your documents", and the second one is not
// being asked here. Adding a corpus-reading tool later is fine; quietly widening
// this one is not.
//
// EVERY NUMBER COMES FROM AN EXISTING STORE FUNCTION. That is a requirement, not
// a convenience: a second implementation of "what did this config save" would
// drift from the dashboard within a month and there would be no way to tell
// which one was lying. The single exception is the override→document join at the
// bottom, which has no existing caller.
import "server-only";

import { z } from "zod";

import { sql } from "@/lib/db";
import { type ResolvedConfig, resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { listConfigComparisons } from "@/lib/rag/appraiseStore";
import { type ConfigSummary, getConfig, listClosedConfigs, listConfigs } from "@/lib/rag/configStore";
import { type ChunkOverride, listOverrides } from "@/lib/rag/overrideStore";
import { getCostsReport } from "@/lib/rag/savingsStore";
import { listDocuments } from "@/lib/rag/vectorStore";

// --- the two shapes the tool can return ------------------------------------
//
// Declared in zod and inferred into TS rather than the other way round, because
// this doubles as the tool's advertised `outputSchema` (lib/mcp/server.ts) and
// two hand-synced definitions of one payload is a bug waiting for a quiet
// afternoon.
//
// WHY EVERY TOP-LEVEL KEY IS OPTIONAL, which otherwise looks like laziness: the
// tool answers in two modes — a picker when called with no id, a full summary
// when called with one — and MCP requires an advertised outputSchema to have an
// OBJECT root. A z.union would be an `anyOf` root, which additionally changes
// the wire shape for 2025-era clients (the SDK wraps non-object-rooted results
// as `{result:…}`). So the schema is one object carrying both branches, and the
// tool description states which fields come back when. The alternative — no
// outputSchema at all — still delivers structuredContent, but gives clients
// nothing to validate against or to show a user.

const PickerShape = {
  configs: z
    .array(z.object({ id: z.string(), label: z.string(), isOpen: z.boolean() }))
    .describe("Every config on the account, open and closed. Present in list mode."),
  hint: z.string().describe("What to do next. Present in list mode."),
};

const DescriptionShape = {
  config: z.object({
    id: z.string(),
    name: z.string().nullable().describe("User-set name, or null when the label is derived."),
    label: z.string(),
    createdAt: z.string(),
  }),
  retrieval: z.object({
    baseModel: z.string(),
    dimension: z.number(),
    chunkSize: z.number(),
    chunkOverlap: z.number(),
    topK: z.number(),
    fusionPool: z.number().nullable().describe("null means auto: max(topK * 4, 50)."),
    cascadeEnabled: z.boolean().describe("Saver mode: answer cheap first, escalate on failure."),
    llmModel: z.string(),
  }),
  corpus: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    sync: z.boolean().describe("Whether membership auto-syncs with the corpus."),
  }),
  documents: z.array(
    z.object({
      id: z.string(),
      fileName: z.string(),
      chunkCount: z.number(),
      ingestedAt: z.string(),
      overrideCount: z.number(),
    }),
  ),
  overrides: z.object({
    total: z.number(),
    byKind: z.record(z.string(), z.number()).describe("model | size | size+model"),
    byModel: z.record(z.string(), z.number()),
    byDocument: z.array(z.object({ fileName: z.string(), count: z.number() })),
  }),
  costs: z.object({
    savedUsd: z.number().describe("Total saved across every lever (realized + structural)."),
    spentUsd: z.number(),
    byLever: z.array(
      z.object({
        lever: z.string(),
        label: z.string(),
        savedUsd: z.number().describe("Signed: a cascade escalation is a negative saving."),
        events: z.number(),
        tokensSaved: z.number(),
      }),
    ),
    totalsByView: z.object({
      realized: z.number(),
      structural: z.number(),
      naive: z.number(),
    }),
  }),
  evaluation: z.object({
    k: z.number().nullable().describe("The k that recall was measured at."),
    recall: z.number().nullable(),
    mrr: z.number().nullable(),
    ndcg: z.number().nullable(),
    questionCount: z.number().nullable(),
    lastRunAt: z.string().nullable(),
  }),
};

export const PickerSchema = z.object(PickerShape);
export const DescriptionSchema = z.object(DescriptionShape);

// The advertised schema: both branches, every key optional. See the note above.
export const DescribeOutputSchema = z
  .object(PickerShape)
  .partial()
  .extend(z.object(DescriptionShape).partial().shape);

export type ConfigPicker = z.infer<typeof PickerSchema>;
export type ConfigDescription = z.infer<typeof DescriptionSchema>;

// Not found and not yours are the SAME answer, deliberately — the store layer
// already collapses them (getConfig filters on activeUserId and returns null for
// a missing row, a malformed uuid, and someone else's config alike), and
// re-splitting them here would turn the tool into an oracle for which config ids
// exist on other accounts.
export type DescribeResult =
  | { ok: true; picker: ConfigPicker }
  | { ok: true; description: ConfigDescription }
  | { ok: false; error: string };

const NOT_FOUND = "No config with that id. Call describe_config with no arguments to list them.";

// epoch ms → ISO, because a model reading `1751414400000` learns nothing and a
// model reading `2025-07-02T...` does. Nulls stay null rather than becoming the
// epoch.
const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

// --- entry point ------------------------------------------------------------

export async function describeConfig(configId?: string): Promise<DescribeResult> {
  if (!configId) return { ok: true, picker: await pickerList() };

  const [summary, resolved] = await Promise.all([getConfig(configId), resolveConfig(configId)]);
  if (!summary || !resolved) return { ok: false, error: NOT_FOUND };

  return { ok: true, description: await describe(summary, resolved) };
}

// Called with no id: name the configs and stop. Both halves, because a closed
// config is still a legitimate thing to ask about — it is closed in the tab bar,
// not deleted — and an agent that could only see open ones would report a
// partial account as a complete one.
async function pickerList(): Promise<ConfigPicker> {
  const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
  return {
    configs: [...open, ...closed].map((c) => ({ id: c.id, label: c.label, isOpen: c.isOpen })),
    hint: "Call again with configId for the full summary.",
  };
}

async function describe(
  summary: ConfigSummary,
  resolved: ResolvedConfig,
): Promise<ConfigDescription> {
  // listDocuments and listOverrides read activeConfig(), so they must run inside
  // withConfig. getCostsReport takes the id explicitly but is folded into the
  // same block to keep it one round of concurrency rather than two.
  const [docs, overrides, costs] = await withConfig(resolved, () =>
    Promise.all([listDocuments(), listOverrides(), getCostsReport(summary.id)]),
  );

  // No withConfig here: this one takes the config explicitly, so it needs only
  // the user scope that `sql` requires.
  const overridesByDocument = await countOverridesByDocument(resolved, overrides);

  // listConfigComparisons is cross-config by design (it powers the Appraise
  // table); one config's row is a filter, not a different query. A config that
  // has never been scored simply has no row, and every metric stays null.
  const comparison = (await listConfigComparisons()).find((c) => c.configId === summary.id);

  return {
    config: {
      id: summary.id,
      name: summary.name,
      // Derived by getConfig via defaultLabel(). Do NOT re-inline the
      // "model · size/overlap" expression here — corpusStore.ts:250 and
      // appraiseStore.ts:73 already did, and a third copy is how a display rule
      // with three implementations ends up with three behaviours.
      label: summary.label,
      createdAt: new Date(summary.createdAt).toISOString(),
    },
    retrieval: {
      // ConfigSummary calls it baseModel, ResolvedConfig calls it
      // embeddingModel; same value, two names. The summary's name wins here
      // because it is the one the UI shows.
      baseModel: summary.baseModel,
      dimension: resolved.dimension,
      chunkSize: summary.chunkSize,
      chunkOverlap: summary.chunkOverlap,
      topK: summary.topK,
      // null means "auto" (max(topK * 4, 50)), which is worth preserving rather
      // than resolving — an agent suggesting a fusion pool should know whether
      // the current one was chosen or defaulted.
      fusionPool: resolved.fusionPool,
      cascadeEnabled: resolved.cascadeEnabled,
      llmModel: summary.llmModel,
    },
    corpus: { id: summary.corpusId, name: summary.corpusName, sync: summary.corpusSync },
    documents: docs.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      chunkCount: d.chunkCount,
      ingestedAt: new Date(d.ingestedAt).toISOString(),
      overrideCount: overridesByDocument.get(d.id) ?? 0,
    })),
    overrides: {
      total: overrides.length,
      byKind: tally(overrides.map((o) => o.kind)),
      byModel: tally(overrides.map((o) => o.model)),
      byDocument: docs
        .map((d) => ({ fileName: d.fileName, count: overridesByDocument.get(d.id) ?? 0 }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count),
    },
    costs: {
      // CostsReport has no single "saved" field — `naive` IS the total, being
      // realized + structural. Reaching for levers.reduce() instead would double
      // count nothing today but would silently diverge the moment a lever lands
      // in neither category.
      savedUsd: costs.totalsByView.naive,
      spentUsd: costs.totalSpentUsd,
      byLever: costs.levers.map((l) => ({
        lever: l.lever,
        label: l.label,
        // SIGNED. A cascade escalation is a negative saving, and clamping it to
        // zero would make saver mode look free when it sometimes isn't.
        savedUsd: l.savedUsd,
        events: l.events,
        tokensSaved: l.tokensSaved,
      })),
      totalsByView: costs.totalsByView,
    },
    evaluation: {
      // Note `recall` is measured AT `k`, which is its own field — there is no
      // fixed "recall@5" in this schema and hardcoding one in the key would
      // misreport every run scored at a different k.
      k: comparison?.k ?? null,
      recall: comparison?.recall ?? null,
      mrr: comparison?.mrr ?? null,
      ndcg: comparison?.ndcg ?? null,
      questionCount: comparison?.questionCount ?? null,
      lastRunAt: iso(comparison?.lastRunAt),
    },
  };
}

const tally = (values: string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});

// --- the one new query ------------------------------------------------------

// Overrides are ALWAYS per-chunk: config_chunk_overrides is the only table, and
// what the UI calls a "document-level override" is reconfigureDocument looping
// every chunk of that document. So a per-document count doesn't exist anywhere
// and has to be derived by joining the override chunk ids back to their
// documents — which is why this is the single piece of new SQL in the feature.
//
// The chunks table name is per model/dimension (chunks_<model>_<dim>) and so has
// to be interpolated as an identifier with sql(...), not as a value.
// overrideStore's chunkLabel() is the existing worked example of this same join.
async function countOverridesByDocument(
  cfg: ResolvedConfig,
  overrides: ChunkOverride[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (overrides.length === 0) return counts;

  const ids = overrides.map((o) => o.sourceChunkId);
  try {
    const rows = await sql<{ document_id: string; n: number }[]>`
      select c.document_id, count(*)::int as n
      from ${sql(cfg.chunksTable)} c
      join document_embeddings de on de.id = c.document_embedding_id
      where c.id = any(${ids}::uuid[]) and de.config_id = ${cfg.id}
      group by c.document_id
    `;
    for (const row of rows) counts.set(row.document_id, row.n);
  } catch (err) {
    // Same 42P01 tolerance listOverrides() itself has: on a config whose chunks
    // table doesn't exist yet the honest answer is "no per-document counts", and
    // failing the whole tool call over a breakdown would be out of proportion.
    if ((err as { code?: string }).code !== "42P01") throw err;
  }
  return counts;
}
