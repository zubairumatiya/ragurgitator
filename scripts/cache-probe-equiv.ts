// EGRESS PART 1 — equivalence check for the semantic-cache probe.
//
//   npm run cache:equiv          compare JS-side bestMatch against the SQL probe
//
// The change this guards (docs/egress-reduction-plan.md, Part 1) replaces "pull
// every candidate row and cosine them in JS" with "let Postgres order by
// `<=>` and return one row". That is meant to be BEHAVIOUR-IDENTICAL, so this
// runs BOTH forms against the live table for the same questions and compares
// what they pick.
//
// Both queries are written out inline here rather than imported, on purpose:
// the old one is being deleted from the app, and a check that called into
// semanticCache.ts would stop comparing two implementations the moment it did.
// This file is the only surviving copy of the old path, which is what makes it
// a regression check afterwards and not just a pre-flight.
//
// The questions come from semantic_cache_shadow — real asked questions that
// already produced a nearest match. Their recorded `sim` is printed as context
// but is NOT the assertion: rows may have been banked or pruned since, so the
// authority is the two queries agreeing with each other TODAY.
//
// Costs nothing: every question is already in embedding_cache, so the embeds
// are L1/L2 hits.
import postgres from "postgres";

import { sql } from "../lib/db";
import { activeUserId } from "../lib/auth/userScope";
import { activeConfig } from "../lib/rag/activeConfig";
import { embedQueryCached } from "../lib/rag/embedCache";
import { bestMatch, type CacheEntry } from "../lib/rag/semanticCacheCore";
import { inScope, loadOwner, type Owner } from "./lib/followup";

const raw = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });

const SAMPLE = Number(process.env.EQUIV_SAMPLE ?? 20);
// Floating-point slack. The two paths sum the SAME float4 values in different
// orders (JS in double, pgvector in float), so they agree to float4 resolution
// rather than exactly — a real disagreement is a DIFFERENT ROW, orders of
// magnitude away from this, not a last-bit difference.
const TOL = 1e-5;

type Probe = { text: string; sim: number } | null;

// The OLD path, verbatim: whole candidate set to the app, cosine in JS.
async function viaJs(vector: number[], keyModel: string, fingerprint: string): Promise<Probe> {
  const cfg = activeConfig();
  const rows = await sql<{ query_text: string; query_vector: number[] }[]>`
    select query_text, query_vector
    from semantic_cache
    where user_id = ${activeUserId()}
      and embedding_model = ${keyModel}
      and llm_model = ${cfg.llmModel}
      and fingerprint = ${fingerprint}
    order by created_at desc
    limit 1000
  `;
  const entries: CacheEntry<string>[] = rows.map((r) => ({
    vector: r.query_vector,
    value: r.query_text,
  }));
  const match = bestMatch(vector, entries);
  return match && { text: match.value, sim: match.sim };
}

// The NEW path: Postgres ranks, one row comes back. `::vector` because
// query_vector is real[] (0031) — the cast is exact, not a re-encoding.
async function viaSql(vector: number[], keyModel: string, fingerprint: string): Promise<Probe> {
  const cfg = activeConfig();
  const rows = await sql<{ query_text: string; sim: number }[]>`
    select query_text, 1 - (query_vector::vector <=> ${vector}::real[]::vector) as sim
    from semantic_cache
    where user_id = ${activeUserId()}
      and embedding_model = ${keyModel}
      and llm_model = ${cfg.llmModel}
      and fingerprint = ${fingerprint}
    order by query_vector::vector <=> ${vector}::real[]::vector asc, created_at desc
    limit 1
  `;
  return rows.length === 0 ? null : { text: rows[0].query_text, sim: Number(rows[0].sim) };
}

// Questions to replay, newest first. Paired with the fingerprint they were
// captured under so the two queries scan the same bucket the question actually
// hit — today's fingerprint may name a different document set entirely.
async function sample(owner: Owner) {
  return raw<{ new_query: string; embedding_model: string; fingerprint: string; sim: string; matched_query: string }[]>`
    select new_query, embedding_model, fingerprint, sim, matched_query
    from semantic_cache_shadow
    where config_id in (select id from configs where user_id = ${owner.id})
    order by created_at desc
    limit ${SAMPLE}
  `;
}

async function main(): Promise<void> {
  const owner = await loadOwner(raw);
  const rows = await sample(owner);
  if (rows.length === 0) throw new Error("no shadow rows to replay");

  let compared = 0;
  let mismatched = 0;
  let empty = 0;

  await inScope(owner, async () => {
    for (const row of rows) {
      const vector = await embedQueryCached(row.new_query, row.embedding_model);
      const js = await viaJs(vector, row.embedding_model, row.fingerprint);
      const pg = await viaSql(vector, row.embedding_model, row.fingerprint);

      // No candidates under that fingerprint any more (pruned, or the bucket
      // moved). Both paths must agree it is empty; that agreement is the check.
      if (js === null || pg === null) {
        empty++;
        if ((js === null) !== (pg === null)) {
          mismatched++;
          console.log(`MISMATCH empty-vs-not  q="${row.new_query.slice(0, 60)}"`);
        }
        continue;
      }

      compared++;
      const sameText = js.text === pg.text;
      const drift = Math.abs(js.sim - pg.sim);
      const ok = sameText && drift <= TOL;
      if (!ok) mismatched++;
      console.log(
        `${ok ? "ok  " : "FAIL"} js=${js.sim.toFixed(6)} pg=${pg.sim.toFixed(6)} ` +
          `Δ=${drift.toExponential(1)} ${sameText ? "" : "DIFFERENT MATCH "}` +
          `(shadow recorded ${Number(row.sim).toFixed(6)}) q="${row.new_query.slice(0, 50)}"`,
      );
      if (!sameText) {
        console.log(`     js matched="${js.text.slice(0, 70)}"`);
        console.log(`     pg matched="${pg.text.slice(0, 70)}"`);
      }
    }
  });

  console.log(
    `\n${rows.length} replayed — ${compared} compared, ${empty} with no candidates, ` +
      `${mismatched} mismatched (tolerance ${TOL})`,
  );
  // Only the raw handle can be closed: `sql` is the scoped store proxy, and
  // reaching for it outside a withUser() scope is exactly what it refuses. That
  // leaves lib/db's app pool open with nothing able to close it, so this exits
  // rather than waiting on a handle it has no reference to.
  await raw.end();
  process.exit(mismatched > 0 ? 1 : 0);
}

void main();
