// STATEMENT BUDGETS for the two hot paths the integration tier can drive
// (docs/obs-4-ci-budgets-plan.md §1.1, second half).
//
// Every latency win in this repo was a statement-count win — the SQL-side cache
// probe, prefetchRetrieval's ~780 → ~10 round trips — and nothing protected
// either. The eval gate budgets base-lane retrieval over the real fixture; this
// file budgets the two shapes it never reaches: a semantic-cache probe that
// hits, and a FOREIGN-lane fusion retrieval, prefetched, for two questions.
//
// The count comes from lib/observability/statementMeter.ts, switched on for the
// whole tier by test/support/env.ts. Only the app's own clients are metered; the
// harness's admin client that builds the fixtures is not, so a fixture can grow
// without moving a budget.
//
// Over budget by more than the margin is red and names the prefixes that grew.
// Under budget passes with a diagnostic: tighten the fixture so the win is kept.
// To refresh after an intended change:
//   STATEMENT_BUDGETS_WRITE=1 npm run itest -- test/integration/statements.itest.ts
// and commit test/fixtures/statement-budgets.json.
//
// NO PROVIDER IS CALLED: every vector either path would embed is pre-seeded
// into embedding_cache, as in semanticCache.itest.ts and fusionPool.itest.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { STATEMENT_METER, statementMeter, type StatementSnapshot } from "../../lib/observability/statementMeter";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { buildRetrievalContext, prefetchRetrieval, retrieveWithCutoffs } from "../../lib/rag/retriever";
import { semanticCacheLookup, semanticCacheStore } from "../../lib/rag/semanticCache";
import { chunksTable, vectorLiteral } from "../../lib/rag/vectorStore";
import { DEFAULT_STMT_MARGIN, prefixMovers, topGrown } from "../../scripts/lib/evalGateCompare";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const BUDGETS_PATH = new URL("../fixtures/statement-budgets.json", import.meta.url);
const WRITE = process.env.STATEMENT_BUDGETS_WRITE === "1";

type Budgets = Record<string, StatementSnapshot>;
const budgets: Budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8"));
const measured: Budgets = {};

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const atCosine = (c: number, dim: number): number[] => {
  const v = new Array(dim).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
};

let admin: Sql;
let user: { id: string; email: string };

async function newConfig(baseModel: string): Promise<{ configId: string; corpusId: string }> {
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('budget corpus', ${user.id}) returning id`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${user.id}, ${corpus.id}, ${baseModel}, 500, 50, 5, 'test-llm') returning id`;
  return { configId: cfg.id, corpusId: corpus.id };
}

function inScope<T>(configId: string, fn: () => Promise<T>): Promise<T> {
  return withUser(user, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

async function bank(kind: "query" | "document", model: string, text: string, vec: number[]) {
  await admin`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    values (${user.id}, ${model}, ${kind}, ${sha256(text)}, ${vec.length},
            ${`{${vec.join(",")}}`}::real[])
    on conflict do nothing`;
}

// The flow's scope entry is inside the measurement on purpose: a request pays
// its begin / set_config / config lookup too, and a change that doubled those
// is exactly what this file is for.
async function measure(t: TestContext, flow: string, fn: () => Promise<void>): Promise<void> {
  statementMeter.reset();
  await fn();
  const run = statementMeter.snapshot();
  measured[flow] = run;
  t.diagnostic(`${flow}: ${run.total} statements ${JSON.stringify(run.byPrefix)}`);
  if (WRITE) return;

  const budget = budgets[flow];
  assert.ok(budget, `no budget for "${flow}" in test/fixtures/statement-budgets.json — run with STATEMENT_BUDGETS_WRITE=1`);
  const grown = topGrown(prefixMovers(budget.byPrefix, run.byPrefix));
  assert.ok(
    run.total <= budget.total * (1 + DEFAULT_STMT_MARGIN),
    `statement budget exceeded for ${flow}: ${budget.total} → ${run.total}; grew: ${grown || "(none)"}`,
  );
  if (run.total < budget.total) {
    t.diagnostic(`${flow} fell ${budget.total} → ${run.total} — refresh statement-budgets.json so the win is kept`);
  }
}

before(async () => {
  assert.ok(STATEMENT_METER, "RAG_STATEMENT_METER is off — test/support/env.ts must be preloaded");
  admin = adminClient();
  await ensureAppRole(admin);
  // postgres.js fetches pg_type once per client, on its first statement. Pay
  // that here so no flow's count depends on which test ran first.
  await fragment`select 1`;
  await privilegedSql`select 1`;
});

after(async () => {
  if (WRITE) writeFileSync(BUDGETS_PATH, JSON.stringify(measured, null, 2) + "\n");
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  user = await createUser(admin);
});

describe("statement budgets", () => {
  it("cache-probe: a semantic cache hit", async (t) => {
    const keyModel = config.semanticCache.keyModel;
    const { configId } = await newConfig(keyModel);
    const RESULT = { answer: "a", sources: [], model: "test-llm", efficacy: null, escalated: false };
    // Three banked answers, one exact: the probe ranks them in SQL and serves the top.
    const rows: [string, number[]][] = [
      ["banked-same", [1, 0, 0, 0]],
      ["banked-near", [0.98, 0.198997, 0, 0]],
      ["banked-far", [0.5, 0.866025, 0, 0]],
    ];
    for (const [q, v] of rows) {
      await bank("query", keyModel, q, v);
      await inScope(configId, () => semanticCacheStore(q, { model: keyModel, vector: v }, RESULT));
    }
    await bank("query", keyModel, "the probe", [1, 0, 0, 0]);

    let hit = false;
    await measure(t, "cache-probe", async () => {
      const probe = await inScope(configId, () =>
        semanticCacheLookup("the probe", { serve: true, threshold: 0.95, keyModel: null }),
      );
      hit = probe.hit;
    });
    assert.equal(hit, true, "the fixture must exercise the serving branch");
  });

  it("fusion: a foreign-lane retrieval, prefetched, for two questions", async (t) => {
    const BASE = "voyage-4-lite";
    const DIM = 1024;
    const FOREIGN = "embed-english-light-v3";
    const FDIM = 4;
    const CHUNKS = chunksTable(BASE, DIM);
    const TEXT = (i: number) => `chunk text number ${i}`;
    const QUESTIONS = ["which chunk?", "a second wording"];

    const { configId, corpusId } = await newConfig(BASE);
    const [doc] = await admin<{ id: string }[]>`
      insert into documents (file_name, content_hash, content, user_id)
      values ('a.txt', ${sha256("a")}, 'the body', ${user.id}) returning id`;
    await admin`insert into corpus_documents (corpus_id, document_id) values (${corpusId}, ${doc.id})`;
    const [run] = await admin<{ id: string }[]>`
      insert into document_embeddings
        (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
      values (${doc.id}, ${BASE}, ${DIM}, 500, 50, 6, ${configId}) returning id`;
    const chunkIds: string[] = [];
    for (const [i, score] of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4].entries()) {
      const [row] = await admin<{ id: string }[]>`
        insert into ${admin(CHUNKS)}
          (document_id, document_embedding_id, position, text, embedding, config_id)
        values (${doc.id}, ${run.id}, ${i}, ${TEXT(i)}, ${vectorLiteral(atCosine(score, DIM))}, ${configId})
        returning id`;
      chunkIds.push(row.id);
    }
    // A foreign-space override opens a fusion lane: the pool is re-embedded
    // under FOREIGN (all banked here) and the override sims are read per question.
    await admin`
      insert into config_chunk_overrides
        (config_id, source_chunk_id, piece_index, model, dimension, kind,
         text, token_start, token_end, embedding)
      values (${configId}, ${chunkIds[5]}, 0, ${FOREIGN}, ${FDIM}, 'model',
              null, null, null, ${`{${atCosine(0.5, FDIM).join(",")}}`}::real[])`;
    for (const q of QUESTIONS) {
      await bank("query", BASE, q, atCosine(1, DIM));
      await bank("query", FOREIGN, q, atCosine(1, FDIM));
    }
    for (const [i, c] of [0.3, 0.2, 0.9, 0.05, 0.1, 0.15].entries()) {
      await bank("document", FOREIGN, TEXT(i), atCosine(c, FDIM));
    }

    let retrieved = 0;
    await measure(t, "fusion", async () => {
      await inScope(configId, async () => {
        const ctx = await buildRetrievalContext();
        const batch = QUESTIONS.map((text) => ({ text, vector: atCosine(1, DIM) }));
        await prefetchRetrieval(ctx, batch, 2);
        for (const q of batch) retrieved += (await retrieveWithCutoffs(q.text, q.vector, 2, ctx)).retrieved.length;
      });
    });
    assert.equal(retrieved, 4, "both questions must retrieve their top 2");
  });
});
