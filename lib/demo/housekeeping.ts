// DAILY HOUSEKEEPING FOR THE DEMO — the sweep that the per-provision reaper is
// the fast path for.
//
// Provisioning already reaps expired guests, which is what makes a two-hour TTL
// mean two hours (Vercel's Hobby plan permits nothing more frequent than a daily
// cron). This is the backstop for the case that path cannot cover: a quiet day
// where nobody starts a demo, so nothing sweeps and the last guest's 8 MB sits
// there until someone arrives.
//
// It also holds the one piece of maintenance NOTHING else can do — see the HNSW
// note below.
import "server-only";

import { privilegedSql } from "@/lib/db";
import { reapExpiredGuests } from "@/lib/demo/guest";
import { pruneProvisionLedger } from "@/lib/demo/rateLimit";

export type HousekeepingReport = {
  reaped: number;
  prunedProvisions: number;
  reindexed: string[];
};

// HNSW DOES NOT GIVE THE SPACE BACK, and this is the only thing that does.
//
// pgvector 0.8 does not reclaim HNSW space on delete: a deleted vector's node
// stays in the graph as a tombstone. So a two-hour TTL churning guests through
// chunks_voyage_4_lite_1024 grows its index MONOTONICALLY — independent of how
// many guests are alive at once, and beyond the reaper's reach. The index is
// already 6.6 KB per row, larger than the heap it indexes, so this is not a
// rounding error over a few hundred guests.
//
// CONCURRENTLY so it does not lock the table against live retrieval, which also
// means it cannot run inside a transaction — hence privilegedSql directly rather
// than through a scope, and hence the best-effort catch: a REINDEX that loses a
// race or trips a statement timeout must not fail the cron that also reaps.
//
// CHECK THE SIZES before letting this run unattended for a week. If the index is
// still growing after a reindex, the tombstones are not the problem and the two
// remaining levers are a smaller seed and a shorter TTL — in that order.
async function reindexHnsw(): Promise<string[]> {
  const rows = await privilegedSql<{ indexname: string }[]>`
    select indexname from pg_indexes
     where schemaname = 'public'
       and tablename like 'chunks\\_%'
       and indexdef ilike '%using hnsw%'
  `;

  const done: string[] = [];
  for (const { indexname } of rows) {
    try {
      // The identifier comes from pg_indexes, not from a caller — there is no
      // interpolation of anything a request could influence.
      await privilegedSql.unsafe(`reindex index concurrently "${indexname}"`);
      done.push(indexname);
    } catch (e) {
      console.warn(`[demo] reindex of ${indexname} failed: ${String(e)}`);
    }
  }
  return done;
}

export async function runDemoHousekeeping(): Promise<HousekeepingReport> {
  const reaped = await reapExpiredGuests().catch((e) => {
    console.warn(`[demo] daily reap failed: ${String(e)}`);
    return 0;
  });
  const prunedProvisions = await pruneProvisionLedger().catch(() => 0);
  const reindexed = await reindexHnsw().catch(() => [] as string[]);
  return { reaped, prunedProvisions, reindexed };
}
