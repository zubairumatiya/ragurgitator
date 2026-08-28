// DB layer for the payoff readout — the three reads behind CacheEconomics. The
// arithmetic and the reasoning are in cacheEconomicsCore.ts; this file only
// fetches, and it fetches for ONE space: the one the config's key model serves in,
// which is the only space this account's traffic was ever measured in.
//
// Best-effort throughout, like the rest of the cache: a missing table (42P01)
// yields an empty census rather than an error, so the readout disappears instead
// of taking the panel down with it.
import { activeUserId } from "@/lib/auth/userScope";
import { config } from "@/lib/config";
import { sql } from "@/lib/db";
import { ownedConfigs } from "@/lib/rag/semanticCacheCalibration";
import { spaceOf } from "@/lib/rag/semanticCacheCore";
import type { CacheEconomics, SimBin } from "@/lib/rag/cacheEconomicsCore";

async function safe<T>(fn: () => Promise<T[]>, fallback: T[]): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return fallback;
    throw err;
  }
}

export async function readCacheEconomics(
  space: string,
  liveThreshold: number,
): Promise<CacheEconomics> {
  const censusFloor = config.semanticCache.shadowLogFloor;

  const [entryRows, binRows, ledger] = await Promise.all([
    // Per embedding_model and folded through spaceOf here, exactly as
    // listThresholdsWithStats does it: the space is a property of the model, not
    // a column, so the mapping has to happen in one place and this is that place.
    // semantic_cache is user-rooted since 0058, so it filters on the user id
    // directly — ownedConfigs() would drop rows whose banking config is gone,
    // which are live and servable.
    safe(
      () =>
        sql<{ embedding_model: string; entries: number }[]>`
          select embedding_model, count(*)::int as entries
          from semantic_cache where user_id = ${activeUserId()}
          group by embedding_model`,
      [],
    ),
    // TRAFFIC ONLY, and only at or above the floor. Probe rows are engineered
    // near-misses nobody asked, so counting them would report a hit rate for a
    // question mix that never arrived; the sub-floor band is a 5% sample sitting
    // next to a census and cannot share a denominator with it.
    safe(
      () =>
        sql<{ sim: number; servable: number; blocked: number }[]>`
          select (floor(sim * 10000) / 10000)::float as sim,
                 count(*) filter (where not guard_blocked)::int as servable,
                 count(*) filter (where guard_blocked)::int as blocked
          from semantic_cache_shadow
          where space = ${space}
            and origin = 'traffic'
            and sim >= ${censusFloor}
            and ${ownedConfigs()}
          group by 1
          order by 1 desc`,
      [],
    ),
    // What a hit has actually been worth, from the ledger rather than from a
    // price table: this is the same signed total the Costs page itemizes, so the
    // two pages can never quote different money for the same lever.
    safe(
      () =>
        sql<{ saved: string | null; events: string | null }[]>`
          select sum(saved_usd) as saved, sum(event_count) as events
          from savings_totals
          where lever = 'semantic_cache' and ${ownedConfigs()}`,
      [],
    ),
  ]);

  const entries = entryRows
    .filter((r) => spaceOf(r.embedding_model) === space)
    .reduce((n, r) => n + r.entries, 0);

  const bins: SimBin[] = binRows
    .filter((r) => r.servable > 0)
    .map((r) => [Number(r.sim), r.servable]);
  const guardBlocked = binRows.reduce((n, r) => n + r.blocked, 0);

  const hitsPriced = Number(ledger[0]?.events ?? 0);
  const savedUsd = Number(ledger[0]?.saved ?? 0);

  return {
    space,
    liveThreshold,
    censusFloor,
    entries,
    bins,
    guardBlocked,
    // A zero-event ledger yields null, not 0: "no hit has been priced yet" and
    // "a hit is worth nothing" are different claims and only one of them is true.
    savedPerHitUsd: hitsPriced > 0 ? savedUsd / hitsPriced : null,
    hitsPriced,
  };
}
