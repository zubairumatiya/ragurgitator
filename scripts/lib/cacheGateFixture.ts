// The pure half of the semantic cache gate's fixture
// (docs/semantic-cache-gate-plan.md §Phase 1): the manifest's shape and the
// checks that refuse a fixture with a hole in it. No DB and no lib/ import.
//
// The fixture freezes the two non-pure inputs of the cache's match decision —
// the key-model vector of every text, and τ — plus the labelled pairs the
// decision is judged on. Everything else the decision needs is code
// (lib/rag/semanticCacheCore.ts), which is the point: the gate re-runs the code
// against fixed data.
import { createHash } from "node:crypto";

import { hashFixture, vecProblem, type VecRef } from "./fixtureBlob";

export { VectorBlob, decodeVectorSend, readVec, serializeManifest, type VecRef } from "./fixtureBlob";

// `embedding_cache.text_hash` is sha256 hex of the utf8 text, and so is the
// vectors map's key — one identity for a text on both sides of the file.
export const textHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export type PairLabel = "same" | "different";
export type Verdict = "accept" | "reject";

// One semantic_cache_pairs row. ALL rows travel, quarantined ones included: the
// gate runs production's own poolPairs, which is what decides who is dropped.
export type FixtureGenerated = {
  textA: string;
  textB: string;
  label: PairLabel;
  difficulty: string;
  verdict: Verdict | null;
  verdictSource: string | null;
};

// One JUDGED semantic_cache_shadow row. `simAtCapture` and `guardBlockedAtCapture`
// are what the model in force at capture time saw — provenance for a reviewer,
// never an input to the decision, which the gate recomputes.
export type FixtureShadow = {
  textA: string; // new_query — the question that arrived
  textB: string; // matched_query — the banked question it was matched to
  verdict: Verdict;
  origin: "traffic" | "probe";
  simAtCapture: number;
  guardBlockedAtCapture: boolean;
};

export type FixtureTau = { value: number; source: "config" | "calibrated" | "default" };

export type Manifest = {
  version: 1;
  exportedAt: string;
  sourceConfigId: string;
  fixtureHash: string;
  keyModel: string;
  space: string;
  dimension: number;
  tau: FixtureTau;
  generated: FixtureGenerated[];
  shadow: FixtureShadow[];
  // One vector per DISTINCT text, under keyModel, keyed by textHash(text).
  vectors: Record<string, VecRef>;
};

export const fixtureHash = (manifest: Manifest, blob: Buffer): string => hashFixture(manifest, blob);

// Every text any row mentions, deduplicated.
export function textsOf(m: Pick<Manifest, "generated" | "shadow">): Set<string> {
  const texts = new Set<string>();
  for (const g of m.generated) texts.add(g.textA).add(g.textB);
  for (const s of m.shadow) texts.add(s.textA).add(s.textB);
  return texts;
}

// Every way the file can point at something that is not there, ALL of them:
// a broken export has one cause and many symptoms, and the list shows the cause.
export function manifestProblems(m: Manifest, blobFloats: number): string[] {
  const problems: string[] = [];
  if (m.generated.length === 0) problems.push("generated: no pairs");
  if (m.shadow.length === 0) problems.push("shadow: no judged rows");
  if (!(m.tau.value > 0 && m.tau.value <= 1)) problems.push(`tau: ${m.tau.value} is not in (0, 1]`);

  const seen = new Set<string>();
  for (const g of m.generated) {
    const key = [g.textA, g.textB].map(textHash).sort().join("|");
    if (seen.has(key)) problems.push(`generated "${g.textA.slice(0, 40)}": duplicate pair`);
    seen.add(key);
    if (g.textA === g.textB) problems.push(`generated "${g.textA.slice(0, 40)}": pair of a text with itself`);
  }
  for (const s of m.shadow) {
    if (s.textA === s.textB) problems.push(`shadow "${s.textA.slice(0, 40)}": pair of a text with itself`);
  }

  for (const text of textsOf(m)) {
    const ref = m.vectors[textHash(text)];
    const where = `text "${text.slice(0, 40)}"`;
    if (!ref) {
      problems.push(`${where}: no vector under ${m.keyModel}`);
      continue;
    }
    const problem = vecProblem(where, ref, blobFloats, m.dimension);
    if (problem) problems.push(problem);
  }
  const mentioned = new Set([...textsOf(m)].map(textHash));
  for (const hash of Object.keys(m.vectors)) {
    if (!mentioned.has(hash)) problems.push(`vectors: ${hash.slice(0, 12)}… belongs to no row`);
  }
  return problems;
}
