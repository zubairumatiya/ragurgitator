// L1.5 — an OPT-IN, ON-DISK layer between embedCache's in-process Map and the
// embedding_cache table. Node-only, and loaded ONLY when EMBED_DISK_CACHE names a
// directory: embedCache reaches it through a dynamic import behind that check, so
// a deployment never imports this file at all.
//
// WHAT IT IS FOR. The sweeps (f1/f3/f4/f7, the leaderboard re-run) each start a
// fresh process, so L1 is empty every time and every run re-downloads the same
// vectors from L2. A full pass over embedding_cache is 16,148 rows / 196 MB on
// the wire, and 2026-08-18's 12.65 GB of Supabase egress is about 65 of those
// passes. This is the layer that makes the second run free.
//
// WHY IT IS SAFE TO CACHE ON DISK. Entries are content-addressed and IMMUTABLE:
// the key is (user, model, input_kind, sha256(text)) and a given text under a
// given model always yields the same vector. Editing a chunk or applying an
// override produces a NEW hash, never a changed entry — so there is no
// invalidation problem here, only growth. Nothing else in the system may follow:
// labels, ideal rankings, quarantine flags and thresholds are all edited in place
// and must be read fresh every run.
//
// WHY BINARY. Postgres ships real[] as TEXT — ~11.8 KB per 1024-dim vector, and
// it must be parsed on arrival. float32 on disk is exactly 4,096 bytes and loads
// as a Float32Array with no parsing at all. All 11 models together are ~66 MB.
//
// float32 IS THE STORED PRECISION — the column is real — so the disk copy loses
// nothing the database was holding. It does not match the JS doubles byte for
// byte, and the reason is the wire, not the disk: this server runs with
// `extra_float_digits = 0`, so a real is printed to 6 significant digits and does
// NOT round-trip. The decimals the app parses today are already ~1e-7 (relative)
// away from the float32 in the table; rounding them back to float32 lands on the
// stored value. Measured worst case over a vector: 3.7e-9 absolute. Below the
// text encoding's own resolution, and far below anything a cosine ranking can
// see — but not zero, so do not write a test asserting equality.
//
// THE TENANCY NOTE. Files are keyed by user id, so the pool cannot serve one
// account another's vectors — but it is still an unencrypted pile of paid-for
// embeddings sitting outside RLS, on a filesystem no policy governs. That is
// acceptable on a personal machine and nowhere else. Deleting the directory is
// always a safe reset; disk is never the source of truth.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type DiskKind = "document" | "query";

// The .idx header travels WITH the mapping so a mismatched file can be refused
// rather than silently reinterpreted — a .bin read at the wrong dimension yields
// plausible garbage vectors, which is the one failure mode worth being paranoid
// about (a wrong vector is a wrong ranking, and nothing throws).
type Index = {
  user: string;
  model: string;
  kind: DiskKind;
  dim: number;
  rows: Record<string, number>; // text_hash -> row ordinal in the .bin
};

const dir = (): string | null => process.env.EMBED_DISK_CACHE || null;

// One entry per (user, model, kind) file pair, loaded once per process. `null`
// means "checked, and there is nothing usable on disk".
const loaded = new Map<string, Index | null>();
const vectors = new Map<string, Float32Array>();

// Model ids contain slashes for local models ("Xenova/all-MiniLM-L6-v2"), which
// would silently create subdirectories. Hash anything unusual rather than
// mangling it, so two ids can never collide into one file.
const safe = (s: string): string =>
  /^[A-Za-z0-9._-]+$/.test(s) ? s : createHash("sha256").update(s).digest("hex").slice(0, 16);

const stem = (user: string, model: string, kind: DiskKind): string =>
  join(dir()!, `${safe(user)}__${safe(model)}__${kind}`);

const key = (user: string, model: string, kind: DiskKind): string =>
  `${user} ${model} ${kind}`;

// Said once per file, not once per miss: a broken cache should be obvious in the
// log without burying the run's own output.
function refuse(k: string, why: string): null {
  console.warn(`[embed-disk-cache] ignoring ${k}: ${why}`);
  loaded.set(k, null);
  return null;
}

// Load a file pair, or decide there isn't a usable one. Every disagreement
// between the header and the bytes is a refusal, never a repair.
function load(user: string, model: string, kind: DiskKind): Index | null {
  const k = key(user, model, kind);
  if (loaded.has(k)) return loaded.get(k)!;

  const base = stem(user, model, kind);
  if (!existsSync(`${base}.idx`) || !existsSync(`${base}.bin`)) {
    loaded.set(k, null);
    return null;
  }

  let index: Index;
  try {
    index = JSON.parse(readFileSync(`${base}.idx`, "utf8")) as Index;
  } catch (err) {
    return refuse(k, `unreadable .idx (${(err as Error).message})`);
  }
  if (index.user !== user || index.model !== model || index.kind !== kind) {
    return refuse(k, "header names a different (user, model, kind)");
  }
  if (!index.dim || index.dim < 1) return refuse(k, "header has no dimension");

  const count = Object.keys(index.rows).length;
  const bytes = statSync(`${base}.bin`).size;
  // The size check is what catches a half-written append: the .bin is written
  // first and the .idx second, so a crash between them leaves a LONGER .bin than
  // the index claims. That is recoverable (the extra rows are simply unreachable)
  // and only a SHORTER one is corruption.
  if (bytes < count * index.dim * 4) {
    return refuse(k, `.bin is ${bytes}B, shorter than the ${count} rows the .idx claims`);
  }

  const buf = readFileSync(`${base}.bin`);
  vectors.set(k, new Float32Array(buf.buffer, buf.byteOffset, Math.floor(bytes / 4)));
  loaded.set(k, index);
  return index;
}

// Vectors already on disk, keyed by text hash. Absent hashes are simply missing —
// the caller falls through to the database for those.
export function readDisk(
  user: string,
  model: string,
  kind: DiskKind,
  hashes: string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!dir() || hashes.length === 0) return out;

  const index = load(user, model, kind);
  if (!index) return out;
  const all = vectors.get(key(user, model, kind))!;

  for (const hash of hashes) {
    const row = index.rows[hash];
    if (row === undefined) continue;
    const start = row * index.dim;
    if (start + index.dim > all.length) continue; // truncated file; treat as a miss
    out.set(hash, Array.from(all.subarray(start, start + index.dim)));
  }
  return out;
}

// A best-effort exclusive lock. Concurrent sweeps appending to one .bin would
// interleave, so a second writer SKIPS the disk write rather than waiting — it
// still has its vectors from the database, and the next run re-persists them.
// A lock older than the timeout is treated as abandoned (a killed sweep must not
// disable the cache forever).
const LOCK_STALE_MS = 5 * 60 * 1000;

function withLock(base: string, fn: () => void): void {
  const lock = `${base}.lock`;
  if (existsSync(lock)) {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return;
    rmSync(lock, { force: true });
  }
  let fd: number;
  try {
    fd = openSync(lock, "wx"); // O_EXCL: whoever creates it owns the write
  } catch {
    return; // lost the race
  }
  try {
    fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

// Persist vectors the database had to supply. Appends only — an existing hash is
// left alone, since it is by construction the same vector.
//
// Best-effort in every direction: this is a cache under a cache, and no failure
// here is worth failing a sweep over.
export function appendDisk(
  user: string,
  model: string,
  kind: DiskKind,
  entries: { hash: string; vector: number[] }[],
): void {
  if (!dir() || entries.length === 0) return;
  const dim = entries[0].vector.length;
  if (entries.some((e) => e.vector.length !== dim)) return; // mixed dims: not ours to reconcile

  try {
    mkdirSync(dir()!, { recursive: true });
    const base = stem(user, model, kind);
    withLock(base, () => {
      // Re-read under the lock rather than trusting the in-process copy: another
      // process may have appended since this one loaded the file, and its rows
      // would be lost by an index written from stale state.
      loaded.delete(key(user, model, kind));
      vectors.delete(key(user, model, kind));
      const current = load(user, model, kind);
      if (current && current.dim !== dim) {
        console.warn(
          `[embed-disk-cache] not appending to ${model}/${kind}: on disk is ${current.dim}-dim, ` +
            `these vectors are ${dim}-dim. Delete ${base}.* to reset.`,
        );
        return;
      }

      const index: Index = current ?? { user, model, kind, dim, rows: {} };
      let next = existsSync(`${base}.bin`) ? statSync(`${base}.bin`).size / (dim * 4) : 0;
      const fresh = entries.filter((e) => index.rows[e.hash] === undefined);
      if (fresh.length === 0) return;

      const buf = Buffer.alloc(fresh.length * dim * 4);
      fresh.forEach((e, i) => {
        for (let d = 0; d < dim; d++) buf.writeFloatLE(e.vector[d], (i * dim + d) * 4);
        index.rows[e.hash] = next++;
      });

      // Bytes first, mapping second, and the mapping through a rename: the .idx
      // is the only thing a reader trusts, so it must never name a row the .bin
      // does not yet hold.
      appendFileSync(`${base}.bin`, buf);
      writeFileSync(`${base}.idx.tmp`, JSON.stringify(index));
      renameSync(`${base}.idx.tmp`, `${base}.idx`);

      // Force a reload on next read rather than patching the in-process copy,
      // which would have to stay byte-identical to the file to be worth anything.
      loaded.delete(key(user, model, kind));
      vectors.delete(key(user, model, kind));
    });
  } catch (err) {
    console.warn(`[embed-disk-cache] append failed: ${(err as Error).message}`);
  }
}
