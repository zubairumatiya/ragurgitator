// ---------------------------------------------------------------------------
// CLUSTER LABELING — the "Claude-naming step" referenced in
// migrations/0008_clusters.sql (clusters.label is null until this runs).
//
// Turns a run's buckets into short, human-readable topic labels. Pure I/O around
// one Claude call: the caller supplies each bucket's representative snippets (see
// clusterStore.representativeChunksForRun) and we return one label per ordinal.
// Batching every bucket into a single call lets the model see them together and
// produce distinct, non-overlapping labels — and is far cheaper than k calls.
// (Very large k makes for a big prompt; batch the buckets if that becomes a
// problem.) Reuses config.llmModel so the label model tracks answer generation.
// ---------------------------------------------------------------------------
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicClient } from "@/lib/llm/client";
import { activeConfig } from "@/lib/rag/activeConfig";

export type BucketSamples = { ordinal: number; chunks: string[] };
export type BucketLabel = { ordinal: number; label: string };

const SYSTEM_PROMPT = `You name clusters of related document chunks.

You'll get several numbered buckets, each with a few representative chunks (full
text). Give each bucket a short topic label (at most 6 words, Title Case)
capturing what its chunks have in common. Keep the labels distinct from one
another and ground them ONLY in the chunks shown — do not invent topics.

Respond with ONLY a JSON array, no prose and no code fences:
[{"ordinal": <number>, "label": "<short label>"}]`;

const LabelArray = z.array(
  z.object({ ordinal: z.number().int(), label: z.string().trim().min(1) }),
);

// The Anthropic request params to label every bucket in one call — factored out
// so the inline path (labelBuckets) and the batch path
// (lib/batch/jobs/clusterLabeling) build the SAME prompt. `model` is passed in
// so this stays scope-free.
export function labelRequestParams(
  buckets: BucketSamples[],
  model: string,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const userMessage = buckets
    .map((b) => {
      const chunks = b.chunks
        .map((s, i) => `  ${i + 1}. ${s.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      return `Bucket ${b.ordinal}:\n${chunks || "  (no chunks)"}`;
    })
    .join("\n\n");
  return {
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  };
}

// Parse a labeler response — inline Message or batch result body — into labels,
// keeping only the buckets we asked about, deduping ordinals and clamping length.
export function parseBucketLabels(
  message: { content: Array<{ type: string; text?: string }> },
  buckets: BucketSamples[],
): BucketLabel[] {
  const block = message.content.find((b) => b.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("Labeler returned no text content.");

  const parsed = LabelArray.parse(JSON.parse(stripFences(block.text)));

  const asked = new Set(buckets.map((b) => b.ordinal));
  const seen = new Set<number>();
  const out: BucketLabel[] = [];
  for (const { ordinal, label } of parsed) {
    if (!asked.has(ordinal) || seen.has(ordinal)) continue;
    seen.add(ordinal);
    out.push({ ordinal, label: label.slice(0, 100) });
  }
  return out;
}

export async function labelBuckets(buckets: BucketSamples[]): Promise<BucketLabel[]> {
  if (buckets.length === 0) return [];
  const response = await anthropicClient.messages.create(
    labelRequestParams(buckets, activeConfig().llmModel),
  );
  return parseBucketLabels(response, buckets);
}

// Models occasionally wrap JSON in ```json fences despite instructions; strip them.
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
