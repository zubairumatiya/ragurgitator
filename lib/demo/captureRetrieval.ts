// BANKING THE WALK'S RETRIEVAL — phase 2 of docs/demo-retrieval-bank-plan.md.
//
// scripts/demo-walk drives a dev server, started with DEMO_RETRIEVAL_RECORD,
// through the demo's reachable paths (§4); lib/rag/retrievalRecord appends one
// NDJSON line per retrieval those guests COMPUTED. This module turns that file
// into `demo_replay` rows on the seed: one row per portable retrieval key, the
// question lists under it, in text-hash form (lib/demo/replayCore.packRetrieval).
// Clone step 5l rewrites the hashes into each guest's ids.
//
// THE captureTuning SHAPE: a pack and a census, and the census is taken from the
// packed payloads themselves so the number the publish prints is the number the
// store holds. THIS MODULE WRITES THE SEED through privilegedSql, like every
// other publish-time step — a script has no request scope.
//
// REPLACE, THEN PRUNE. writeRetrieval replaces by key; pruneRetrieval drops the
// keys this walk did not reach, so a re-walk that reaches fewer states cannot
// leave a stale state from the last one underneath — the same rule pruneTuning
// holds for the tuning shelf.
import "server-only";

import { readFileSync } from "node:fs";

import { privilegedSql } from "@/lib/db";
import { pruneRetrieval, writeRetrieval } from "@/lib/demo/replay";
import {
  packRetrieval,
  retrievalBytes,
  type ReplayRetrieval,
  type RetrievalRecord,
} from "@/lib/demo/replayCore";

// One NDJSON file, every line a RetrievalRecord. A line that does not parse is
// a defect in the recorder, not something to skip past: it throws with the
// line number.
export function readRetrievalRecords(file: string): RetrievalRecord[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: RetrievalRecord[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      out.push(JSON.parse(line) as RetrievalRecord);
    } catch {
      throw new Error(`${file}:${i + 1} is not a retrieval record`);
    }
  });
  return out;
}

export type RetrievalCensus = {
  records: number; // lines read, duplicates included
  states: number; // distinct portable keys — one demo_replay row each
  questions: number; // question lists across every state
  bytes: number; // what the rows weigh together, as stored
  contested: number; // (state, question) pairs two guests ranked differently — left out, so they compute
  // Per state, how many questions — the shape §4 predicts is a few full states
  // (~30–60) and many confirm-intermediate ones (1–2).
  perState: { key: string; questions: number }[];
};

export function retrievalCensus(
  records: RetrievalRecord[],
  banks: Map<string, ReplayRetrieval>,
  contested: number,
): RetrievalCensus {
  const perState = [...banks.entries()]
    .map(([key, b]) => ({ key, questions: Object.keys(b.questions).length }))
    .sort((a, b) => b.questions - a.questions || (a.key < b.key ? -1 : 1));
  return {
    records: records.length,
    states: banks.size,
    questions: perState.reduce((n, s) => n + s.questions, 0),
    bytes: retrievalBytes(banks.values()),
    contested,
    perState,
  };
}

// Pack and write. Returns the census of what was written.
export async function bankRetrieval(userId: string, records: RetrievalRecord[]): Promise<RetrievalCensus> {
  const { banks, contested } = packRetrieval(records);
  for (const [key, bank] of banks) await writeRetrieval(userId, key, bank, privilegedSql);
  await pruneRetrieval(userId, [...banks.keys()], privilegedSql);
  return retrievalCensus(records, banks, contested.length);
}
