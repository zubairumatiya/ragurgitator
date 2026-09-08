// THE PUBLISH WALK — phase 2 of docs/demo-retrieval-bank-plan.md §4.
//
//   DEMO_RETRIEVAL_RECORD=$PWD/data/demo-walk/retrieval.ndjson npm run dev   (port 3002)
//   npm run demo:walk -- --yes                 walk every path, bank the result on the seed
//   npm run demo:walk -- --yes --paths 1,docs  a subset (1, 2, 5, docs)
//   npm run demo:walk -- --yes --paths docs --append   add paths to an existing record
//   npm run demo:walk -- --pack                bank an existing record file without walking
//
// A guest's reachable retrieval states are finite because every input is banked
// — the question sets, the per-document boards, the tuning shelf and a
// deterministic install order — so the publish RECORDS them by walking them.
// This script mints throwaway guests off the seed against a dev server started
// with DEMO_RETRIEVAL_RECORD (lib/rag/retrievalRecord), drives each path with the
// same three requests the bench uses (scripts/autotune-bench.ts: Add cached →
// Score pending → ⚙), then packs the recorded lines into `demo_replay` rows on
// the seed (lib/demo/captureRetrieval). Every guest minted afterwards inherits
// them through clone step 5l.
//
// THE PATHS, and why fewer than the plan's eleven. §4 lists "medium → Score → ⚙"
// and its second press as paths 3 and 4; a guest cannot reach them. Add cached
// hands out ONE banked question per chunk per press in `order by difficulty,
// slot` (lib/rag/questionCache.fillChunksFromCache), so the first press is
// always the easy set and the second always adds medium — there is no button
// that takes medium first. What remains:
//
//   1     easy → Score → ⚙                       the default walk
//   2     (1) → + medium → Score → ⚙             second press, set:easy+medium
//   5     easy, + medium → Score → ⚙             one press over sixty
//   docs  one document (each) → Score → ⚙        the "one document" walk, a fresh
//                                                guest each — a fresh guest IS the
//                                                board Start over leaves behind
//
// THE SEED'S OLD BANK IS CLEARED FIRST, and it has to be: the recorder writes
// only what a guest COMPUTED, so a walk against a seed whose guests already hit
// would record nothing and then prune everything. Clearing is what the
// republish does anyway (clone step 0), so the seed is in the state a fresh
// publish leaves it in.
//
// Costs $0 beyond the walks' query embeds (Voyage-priced fractions of a cent,
// docs/autotune-press-latency-plan.md §5); the presses replay the tuning shelf.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { privilegedSql } from "../lib/db";
import { bankRetrieval, readRetrievalRecords } from "../lib/demo/captureRetrieval";
import { pruneRetrieval } from "../lib/demo/replay";
import { DEMO_RETRIEVAL_MAX_BYTES } from "../lib/demo/replayCore";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};

const BASE = valueOf("--base", "http://localhost:3002");
const RECORD = resolve(valueOf("--record", process.env.DEMO_RETRIEVAL_RECORD ?? "data/demo-walk/retrieval.ndjson"));
const PATHS = new Set(valueOf("--paths", "1,2,5,docs").split(",").map((s) => s.trim()));

function die(msg: string): never {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

type Guest = { cookie: string; configId: string };
const rnd = (n: number) => Math.floor(Math.random() * n);

async function mintGuest(): Promise<Guest> {
  const ip = `10.${rnd(255)}.${rnd(255)}.${rnd(254) + 1}`;
  const res = await fetch(`${BASE}/api/demo/start`, { method: "POST", headers: { "x-forwarded-for": ip } });
  if (!res.ok) throw new Error(`demo/start ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { redirect: string };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("demo/start set no cookie");
  return { cookie, configId: body.redirect.replace(/^\/c\//, "") };
}

async function stream(guest: Guest, path: string, body: unknown): Promise<{ ms: number; last: Record<string, unknown> | null }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}?configId=${guest.configId}`, {
    method: "POST",
    headers: { cookie: guest.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 400)}`);
  const events = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const last = events[events.length - 1] ?? null;
  if (last?.type === "error") throw new Error(`${path} streamed an error: ${JSON.stringify(last)}`);
  return { ms: performance.now() - t0, last };
}

async function documentsOf(guest: Guest): Promise<{ id: string; fileName: string }[]> {
  const res = await fetch(`${BASE}/api/documents?configId=${guest.configId}`, { headers: { cookie: guest.cookie } });
  if (!res.ok) throw new Error(`documents ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { documents: { id: string; fileName: string }[] }).documents;
}

const recordLines = (): number => (existsSync(RECORD) ? statSync(RECORD).size : 0);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// One lap: Add cached (optionally scoped to documents) → Score pending → ⚙.
async function lap(guest: Guest, label: string, documentIds?: string[], presses = 1): Promise<void> {
  for (let i = 1; i <= presses; i++) {
    const before = recordLines();
    const add = await stream(guest, "/api/eval/bulk-generate", { cachedOnly: true, ...(documentIds ? { documentIds } : {}) });
    const score = await stream(guest, "/api/eval/process", {});
    const press = await stream(guest, "/api/eval/autotune", {});
    const done = press.last ?? {};
    console.log(
      `  ${label}${presses > 1 ? ` press ${i}` : ""}: add ${secs(add.ms)} · score ${secs(score.ms)} · press ${secs(press.ms)}` +
        ` · recall ${fmt(done.recall)} mrr ${fmt(done.mrr)} · +${recordLines() - before} bytes recorded`,
    );
  }
}

// Path 5: both sets before any press.
async function lapBothSets(guest: Guest): Promise<void> {
  const before = recordLines();
  await stream(guest, "/api/eval/bulk-generate", { cachedOnly: true });
  await stream(guest, "/api/eval/bulk-generate", { cachedOnly: true });
  const score = await stream(guest, "/api/eval/process", {});
  const press = await stream(guest, "/api/eval/autotune", {});
  const done = press.last ?? {};
  console.log(
    `  path 5: score ${secs(score.ms)} · press ${secs(press.ms)} · recall ${fmt(done.recall)} mrr ${fmt(done.mrr)}` +
      ` · +${recordLines() - before} bytes recorded`,
  );
}

const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(3) : "?");

async function main() {
  const seed = process.env.DEMO_SEED_USER_ID?.trim();
  if (!seed) die("DEMO_SEED_USER_ID is not set — it names the account guests clone from, and where the bank is written.");

  if (!has("--pack")) {
    if (!has("--yes")) {
      die(
        `This walk CLEARS the retrieval bank on the seed ${seed.slice(0, 8)} and rebuilds it from\n` +
          `guests minted at ${BASE}, recorded to ${RECORD}.\n` +
          "The dev server must have been started with DEMO_RETRIEVAL_RECORD set to that path.\n" +
          "Re-run with --yes to proceed.",
      );
    }
    mkdirSync(dirname(RECORD), { recursive: true });
    if (has("--append")) {
      // Add paths to an existing record: the seed's bank stays, so states it
      // already holds HIT and record nothing — which is fine, the file still has
      // their lines from the first walk and the pack below merges the whole file.
      console.log(`appending to ${RECORD}; the seed's bank is kept\n`);
    } else {
      writeFileSync(RECORD, "");
      // Clear first: a guest minted from a seed that still holds a bank would hit,
      // and a hit is never recorded.
      await pruneRetrieval(seed, [], privilegedSql);
      console.log(`cleared the retrieval bank on the seed; recording to ${RECORD}\n`);
    }

    if (PATHS.has("1") || PATHS.has("2")) {
      const g = await mintGuest();
      console.log(`guest ${g.configId} (paths 1${PATHS.has("2") ? " + 2" : ""})`);
      await lap(g, "path 1/2", undefined, PATHS.has("2") ? 2 : 1);
      if (recordLines() === 0) {
        die(
          `nothing was recorded during the first lap. The dev server at ${BASE} is not writing to\n` +
            `${RECORD} — start it with:\n  DEMO_RETRIEVAL_RECORD=${RECORD} npm run dev`,
        );
      }
    }
    if (PATHS.has("5")) {
      const g = await mintGuest();
      console.log(`guest ${g.configId} (path 5)`);
      await lapBothSets(g);
    }
    if (PATHS.has("docs")) {
      // Document ids are minted per clone, so each guest's board is scoped by
      // ITS OWN id for the file — a probe's id names nothing in the next guest.
      const probe = await mintGuest();
      const files = (await documentsOf(probe)).map((d) => d.fileName).sort();
      console.log(`guest ${probe.configId} lists ${files.length} document(s); one board each`);
      let g: Guest | null = probe;
      for (const file of files) {
        g ??= await mintGuest();
        const own = (await documentsOf(g)).find((d) => d.fileName === file);
        if (!own) throw new Error(`guest ${g.configId} has no document ${file}`);
        await lap(g, `doc ${file}`, [own.id]);
        g = null;
      }
    }
  }

  if (!existsSync(RECORD)) die(`no record file at ${RECORD}`);
  const records = readRetrievalRecords(RECORD);
  console.log(`\n${records.length} recorded retrieval(s) in ${RECORD}`);
  const census = await bankRetrieval(seed, records);
  console.log(
    `banked ${census.states} state(s) / ${census.questions} question list(s) on the seed at ` +
      `${(census.bytes / 1024).toFixed(0)} KB`,
  );
  if (census.contested > 0) {
    console.log(
      `  ${census.contested} (state, question) pair(s) left out — two guests ranked them differently ` +
        `(a near-tie under query-embedding drift); they compute, as today`,
    );
  }
  for (const s of census.perState.slice(0, 12)) console.log(`  ${s.key.slice(0, 12)}  ${String(s.questions).padStart(3)} questions`);
  if (census.perState.length > 12) console.log(`  … ${census.perState.length - 12} more state(s)`);
  if (census.bytes > DEMO_RETRIEVAL_MAX_BYTES) {
    console.log(
      `⚠ the retrieval bank is ${(census.bytes / 1024).toFixed(0)} KB, over the ` +
        `${(DEMO_RETRIEVAL_MAX_BYTES / 1024).toFixed(0)} KB this is meant to stay under.`,
    );
  }
  if (census.states === 0) {
    console.log("⚠ nothing banked — every guest will compute its retrieval, at today's speed.");
  }
  await privilegedSql.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
