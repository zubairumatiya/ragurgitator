// THE REPLAY STORE — phase 1 of docs/demo-cache-replay-plan.md.
//
// In the demo, every paid step of Appraise → Semantic caching is a REPLAY of a
// real measurement the master made at publish time: not a simulation and not an
// interpolation, but the actual arithmetic re-run over the part of it the
// visitor has reached. This module is the shelf that arithmetic sits on
// (`demo_replay`, 0080) and the only thing that reads or writes it.
//
// THREE OF THE KINDS ARE THREE TENSES OF ONE MEASUREMENT, not three unrelated
// things. `matrix` is what the master computed; `progress` is how far this
// visitor has walked into it; `shadow_verdict` is the judge's own answer for a
// row the clone deliberately blanked so the visitor could answer it themselves.
// `board` (0081) is the fourth, and `ndcg_ideal` / `llm_ranking` (0082) are the
// fifth and sixth: those three are the EVAL TAB's rather than the caching lane's
// — its scope, and the two rankings a guest may not buy — banked here because
// they are the same thing in every other respect: publish-written, guest-read,
// account-wide. lib/demo/replayCore names their payloads.
//
// THE CARVE-OUT IS THE FUNCTION, which is the rule lib/demo/pairBank already
// holds and the reason guards.ts sweep 7 can pin it: every READ here returns
// null for anyone who is not a guest, so a route may call it unconditionally and
// still fail closed. A real account gets null and falls through to the ordinary
// path, byte-for-byte as it is today — a replay handed to the operator would be
// a measurement implying a computation that did not happen.
//
// The WRITES are not guest-gated, and cannot be: they run at publish time in the
// master's scope (the matrix) and inside the clone's own transaction (the
// verdicts), neither of which is a guest request. They take an explicit userId
// and a transaction for exactly that reason.
import "server-only";

import type postgres from "postgres";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { isGuest } from "@/lib/demo/guest";
import {
  BOARD_KEY,
  IDEAL_KEY,
  LLM_RANKING_KEY,
  MATRIX_KEY,
  PROGRESS_KEY,
  type ReplayBoard,
  type ReplayMatrix,
  type ReplayProgress,
  type ReplayRankings,
  type ReplayShadowVerdict,
  type ReplayTuning,
  TUNING_KEY,
} from "@/lib/demo/replayCore";

// Same 42P01 tolerance published_sweep and demo_pair_bank hold, for the same
// reason: a build deployed before 0080 has no store, which is not an error — it
// is a workspace published without one, and it takes the same path as an empty
// one. Every reader below returns null through it.
const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const withoutStore = <T>(work: Promise<T>): Promise<T | null> =>
  work.catch((err: unknown) => {
    if (isMissingTable(err)) return null;
    throw err;
  });

// --- writes: publish time and clone time only -------------------------------

// A writer that works both on its own (the publish, in its own process) and
// inside the clone's transaction, since the shadow verdicts must land in the
// same transaction that mints the shadow rows they name.
type Writer = postgres.TransactionSql | typeof sql;

// REPLACE, NEVER APPEND. `on conflict do update` on the whole primary key is
// what makes a re-publish overwrite the last build instead of stacking a second
// matrix on top of it — the failure 0080's key shape exists to rule out.
async function put(
  db: Writer,
  userId: string,
  kind: string,
  key: string,
  payload: unknown,
): Promise<void> {
  await db`
    insert into demo_replay (user_id, kind, key, payload)
    values (${userId}, ${kind}, ${key}, ${db.json(payload as never)})
    on conflict (user_id, kind, key)
      do update set payload = excluded.payload, updated_at = now()
  `;
}

export async function writeMatrix(userId: string, matrix: ReplayMatrix, db: Writer = sql): Promise<void> {
  await put(db, userId, "matrix", MATRIX_KEY, matrix);
  forgetMatrix(userId);
}

// The board the demo's Eval tab is scoped to (phase 2 of
// docs/demo-real-flow-plan.md). Written on the MASTER by the publish, before the
// clone, for writeMatrix's reason exactly: the ids it holds are the master's,
// and clone step 5g is what rewrites them into each destination's id space.
export async function writeBoard(userId: string, board: ReplayBoard, db: Writer = sql): Promise<void> {
  await put(db, userId, "board", BOARD_KEY, board);
  forgetBoard(userId);
}

// The rankings the demo's Eval tab replays: the master's aggregate ideals
// (`ndcg_ideal`) and the llm_rerank orders bought once at publish time
// (`llm_ranking`). Written on the MASTER, before the clone, for writeBoard's
// reason — the chunk ids they hold are the master's, and clone step 5i is what
// rewrites them into each destination's id space.
export async function writeIdeals(userId: string, rankings: ReplayRankings, db: Writer = sql): Promise<void> {
  await put(db, userId, "ndcg_ideal", IDEAL_KEY, rankings);
  forgetRankings(userId);
}

export async function writeLlmRankings(userId: string, rankings: ReplayRankings, db: Writer = sql): Promise<void> {
  await put(db, userId, "llm_ranking", LLM_RANKING_KEY, rankings);
  forgetRankings(userId);
}

// The tuning the demo's ⚙ Auto tune replays: the master's confirmed per-chunk
// overrides for the board, with the model trials that go with them. Written on
// the MASTER before the clone, on writeIdeals' terms — every entry names a chunk,
// and clone step 5j is what rewrites those ids into a destination's space.
export async function writeTuning(userId: string, tuning: ReplayTuning, db: Writer = sql): Promise<void> {
  await put(db, userId, "tuning", TUNING_KEY, tuning);
  forgetTuning(userId);
}

// The guest's progress, written at clone time so their first page load has a
// starting `n` rather than a null the panel has to have an opinion about.
export async function writeProgress(userId: string, progress: ReplayProgress, db: Writer = sql): Promise<void> {
  await put(db, userId, "progress", PROGRESS_KEY, progress);
}

// One banked verdict per queued shadow row, keyed by the GUEST's own shadow id —
// see 0080 on why that key is text and not a foreign key.
export async function writeShadowVerdicts(
  userId: string,
  verdicts: Map<string, ReplayShadowVerdict>,
  db: Writer = sql,
): Promise<void> {
  for (const [shadowId, verdict] of verdicts) {
    await put(db, userId, "shadow_verdict", shadowId, verdict);
  }
}

// Everything this user has banked, dropped. Clone step 0's republish path calls
// it for demo_pair_bank's reason exactly: these rows hang off user_profiles
// ALONE, so no cascade in that list reaches them and a republish would leave the
// last build's matrix under the new build's pairs.
export async function clearReplay(userId: string, db: Writer = sql): Promise<void> {
  await db`delete from demo_replay where user_id = ${userId}`;
  forgetMatrix(userId);
  forgetBoard(userId);
  forgetRankings(userId);
  forgetTuning(userId);
}

// --- the read, and the memo in front of it ----------------------------------

// PER-PROCESS, PER-USER MEMO, on readPublishedSweep's argument and under its
// conditions: the matrix is re-read on every panel mount, Supabase bills the
// Postgres → app-server hop uncompressed, and ~30 kB of floats per mount is the
// kind of egress the demo has already been over budget on once. It is safe to
// memo because the matrix has NO writer in any request path — a guest's clicks
// write `progress`, never this — so within a guest's ~2-hour life it is
// immutable.
//
// NEGATIVE RESULTS ARE NOT CACHED. The clone writes the guest's matrix DURING
// provisioning, in this same process, so "no matrix yet" is a state that
// legitimately changes while "here is the matrix" is not. Caching the miss would
// be the one way this memo could serve a guest a permanently dead §4.
const memo = new Map<string, ReplayMatrix>();
const MEMO_MAX = 200;

export function forgetMatrix(userId?: string): void {
  if (userId === undefined) memo.clear();
  else memo.delete(userId);
}

// The board gets its own memo on the same terms, and it needs one more than the
// matrix does: getSummary asks for it on EVERY Eval lap to scope the chunk
// query, where the matrix is read once per panel mount. Same immutability
// argument — only a publish and a clone write kind='board', never a request —
// and the same refusal to cache a miss, since the clone writes a guest's board
// during provisioning in this same process.
const boardMemo = new Map<string, ReplayBoard>();

export function forgetBoard(userId?: string): void {
  if (userId === undefined) boardMemo.clear();
  else boardMemo.delete(userId);
}

// The banked matrix for the scoped account, or null for a real one.
export async function readMatrix(): Promise<ReplayMatrix | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  const memoed = memo.get(userId);
  if (memoed) return memoed;
  const row = await withoutStore(sql<{ payload: ReplayMatrix }[]>`
    select payload from demo_replay
     where user_id = ${userId} and kind = 'matrix' and key = ${MATRIX_KEY}
  `.then((rows) => rows[0] ?? null));
  if (!row) return null;
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(userId, row.payload);
  return row.payload;
}

// The chunk ids this guest's Eval tab is scoped to, or null for a real account
// AND for a guest whose build was published without a board. Those two cases are
// deliberately the same null: a workspace with no published scope is one whose
// chunk list is the whole config, which is what every account outside the demo
// already gets.
export async function readBoard(): Promise<ReplayBoard | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  const memoed = boardMemo.get(userId);
  if (memoed) return memoed;
  const row = await withoutStore(sql<{ payload: ReplayBoard }[]>`
    select payload from demo_replay
     where user_id = ${userId} and kind = 'board' and key = ${BOARD_KEY}
  `.then((rows) => rows[0] ?? null));
  if (!row) return null;
  if (boardMemo.size >= MEMO_MAX) boardMemo.delete(boardMemo.keys().next().value as string);
  boardMemo.set(userId, row.payload);
  return row.payload;
}

// The two ranking kinds share a memo, on the board's terms and for one more
// reason of their own: every press of "Add nDCG rankings" reads the whole shelf,
// and the eval summary asks whether it is stocked on EVERY lap in order to
// decide whether those two buttons render disabled. ~70 kB per lap over the hop
// Supabase bills is the egress this store exists to avoid. Immutable for the
// same reason as the others — only a publish and a clone ever write these kinds
// — and a MISS is still not cached, since the clone stocks a guest's shelf
// during provisioning in this same process.
const rankingMemo = new Map<string, ReplayRankings>();

export function forgetRankings(userId?: string): void {
  if (userId === undefined) rankingMemo.clear();
  else for (const key of [...rankingMemo.keys()]) {
    if (key.startsWith(`${userId}:`)) rankingMemo.delete(key);
  }
}

async function readRankings(kind: "ndcg_ideal" | "llm_ranking", key: string): Promise<ReplayRankings | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  const memoKey = `${userId}:${kind}`;
  const memoed = rankingMemo.get(memoKey);
  if (memoed) return memoed;
  const row = await withoutStore(sql<{ payload: ReplayRankings }[]>`
    select payload from demo_replay
     where user_id = ${userId} and kind = ${kind} and key = ${key}
  `.then((rows) => rows[0] ?? null));
  if (!row) return null;
  if (rankingMemo.size >= MEMO_MAX) rankingMemo.delete(rankingMemo.keys().next().value as string);
  rankingMemo.set(memoKey, row.payload);
  return row.payload;
}

// The master's aggregate ideals for this guest's bank, by question identity, or
// null for a real account AND for a guest whose build was published without
// them. Those two are deliberately the same null: both mean "no shelf", and the
// caller's job in both cases is to take the ordinary path — which for a real
// account is the real builder, and for a guest is the demo gate's refusal.
export async function readIdeals(): Promise<Map<string, (string | null)[]> | null> {
  const banked = await readRankings("ndcg_ideal", IDEAL_KEY);
  return banked === null ? null : new Map(banked.entries.map((e) => [e.q, e.order]));
}

// The llm_rerank orders bought on the master, on readIdeals' terms exactly.
export async function readLlmRankings(): Promise<Map<string, (string | null)[]> | null> {
  const banked = await readRankings("llm_ranking", LLM_RANKING_KEY);
  return banked === null ? null : new Map(banked.entries.map((e) => [e.q, e.order]));
}

// How far this guest has advanced. A MISSING row reads as zero-and-unscreened
// rather than as null, because that is what it means: a workspace whose visitor
// has pressed nothing. Only the non-guest case is null, and it is the carve-out.
export async function readProgress(): Promise<ReplayProgress | null> {
  if (!(await isGuest())) return null;
  const row = await withoutStore(sql<{ payload: ReplayProgress }[]>`
    select payload from demo_replay
     where user_id = ${activeUserId()} and kind = 'progress' and key = ${PROGRESS_KEY}
  `.then((rows) => rows[0] ?? null));
  return row?.payload ?? { generated: 0, screened: false };
}

// The banked verdicts for this guest's queued shadow rows, by shadow id.
export async function readShadowVerdicts(): Promise<Map<string, ReplayShadowVerdict> | null> {
  if (!(await isGuest())) return null;
  const rows = await withoutStore(sql<{ key: string; payload: ReplayShadowVerdict }[]>`
    select key, payload from demo_replay
     where user_id = ${activeUserId()} and kind = 'shadow_verdict'
  `);
  if (rows === null) return null;
  return new Map(rows.map((r) => [r.key, r.payload]));
}

// The master's confirmed overrides for this guest's board, or null for a real
// account AND for a guest whose build was published without them — the same
// deliberate null every reader above returns, because the caller's job in both
// cases is the ordinary path: a real search for a real account, and the demo
// gate's refusal for a guest.
//
// A MEMO OF ITS OWN rather than a share of the rankings', because this is the
// heaviest payload in the store (~425 kB of vectors) and the rarest read — once
// per press of one button, against the rankings' every-lap. Holding one is still
// worth it: the step reads it once per SLICE, and a sliced background autotune
// re-enters this function every time it resumes.
const tuningMemo = new Map<string, ReplayTuning>();

export function forgetTuning(userId?: string): void {
  if (userId === undefined) tuningMemo.clear();
  else tuningMemo.delete(userId);
}

export async function readTuning(): Promise<ReplayTuning | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  const memoed = tuningMemo.get(userId);
  if (memoed) return memoed;
  const row = await withoutStore(sql<{ payload: ReplayTuning }[]>`
    select payload from demo_replay
     where user_id = ${userId} and kind = 'tuning' and key = ${TUNING_KEY}
  `.then((rows) => rows[0] ?? null));
  if (!row) return null;
  if (tuningMemo.size >= MEMO_MAX) tuningMemo.delete(tuningMemo.keys().next().value as string);
  tuningMemo.set(userId, row.payload);
  return row.payload;
}
