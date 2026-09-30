// THE PIPELINE'S SPAN TREE, OFF A REAL ask() (docs/obs-5-pipeline-spans-plan.md §1).
//
// The span names and attributes are a contract O6 reads, and nothing but a trace
// shows them: a span opened in the wrong place still type-checks, still returns
// the right answer, and just lands under the wrong parent — or under none. This
// file runs the real ask() and the real eval prefetch against the throwaway
// database, with Sentry's tracer on at 100% and an in-memory transport, and
// asserts the tree that ships.
//
// No provider is called. Every vector is pre-banked in embedding_cache (the
// fusionPool.itest.ts trick), and the one generation goes to a fake Anthropic
// client: lib/llm/client.ts is module-mocked so anthropicFor hands it back
// instead of decrypting a key through Azure. Everything BETWEEN the client and
// the span — meteredMessage, trackKeyUsage, the ledger row — is the real code, so
// the cost on `llm.chat` is checked against the provider_key_usage row it was
// written from.
//
// The mock must be registered before anything imports client.ts, so every app
// module below is a dynamic import after it. Needs --experimental-test-module-mocks
// (the itest script passes it).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { initSentryTracingInMemory } from "../../lib/observability/testing";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

// What the fake client answers with. The usage is what trackKeyUsage prices.
const USAGE = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300 };
let generations = 0;
const fakeAnthropic = {
  messages: {
    create: async (params: { model: string }) => {
      generations++;
      return {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: params.model,
        content: [{ type: "text", text: "a stubbed answer" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: USAGE,
      };
    },
  },
};

type App = {
  withUser: typeof import("../../lib/auth/userScope").withUser;
  db: typeof import("../../lib/db");
  flushSentry: typeof import("../../lib/observability/sentry").flushSentry;
  span: typeof import("../../lib/observability/span").span;
  activeConfig: typeof import("../../lib/rag/activeConfig");
  ask: typeof import("../../lib/rag/pipeline").ask;
  retriever: typeof import("../../lib/rag/retriever");
  vectorStore: typeof import("../../lib/rag/vectorStore");
};
let app: App;

// Top-level await is out (the package is CommonJS), so the mock and every import
// that reaches client.ts happen here, before any test runs.
async function loadApp(): Promise<App> {
  const clientPath = require.resolve("../../lib/llm/client.ts");
  const realClient = await import("../../lib/llm/client");
  // `exports` is Node 24's name (`namedExports` now warns as deprecated), and
  // @types/node does not know it yet, hence the cast.
  mock.module(clientPath, {
    exports: { ...realClient, anthropicFor: async () => fakeAnthropic },
  } as Parameters<typeof mock.module>[1]);
  return {
    withUser: (await import("../../lib/auth/userScope")).withUser,
    db: await import("../../lib/db"),
    flushSentry: (await import("../../lib/observability/sentry")).flushSentry,
    span: (await import("../../lib/observability/span")).span,
    activeConfig: await import("../../lib/rag/activeConfig"),
    ask: (await import("../../lib/rag/pipeline")).ask,
    retriever: await import("../../lib/rag/retriever"),
    vectorStore: await import("../../lib/rag/vectorStore"),
  };
}

type Sql = ReturnType<typeof adminClient>;
type Shipped = ReturnType<typeof initSentryTracingInMemory>[number];

const spans = initSentryTracingInMemory();

const BASE_MODEL = "voyage-4-lite";
// Same vector space as the base: the override folds into the base lane, so
// fusion runs (rag.retrieve.fuse opens) without a foreign lane to embed for.
const OVERRIDE_MODEL = "voyage-4";
const LLM_MODEL = "claude-haiku-4-5";
const DIM = 1024;
const QUESTION = "what does the fixture say?";
const SCORES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const atCosine = (c: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
};

let admin: Sql;
let user: { id: string; email: string };
let configId: string;

async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return app.withUser(user, async () => {
    const cfg = await app.activeConfig.resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return app.activeConfig.withConfig(cfg, fn);
  });
}

async function bankQuery(text: string, vec: number[]) {
  await admin`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    values (${user.id}, ${BASE_MODEL}, 'query', ${sha256(text)}, ${vec.length},
            ${`{${vec.join(",")}}`}::real[])
    on conflict do nothing`;
}

// The spans shipped under one root, by name. Flushing is what sends them: the
// SDK buffers finished spans until the segment ends and a flush drains them.
async function shippedTree(rootName: string): Promise<{ root: Shipped; all: Shipped[] }> {
  assert.ok(await app.flushSentry(), "the in-memory transport did not drain");
  const roots = spans.filter((s) => s.name === rootName && s.is_segment);
  assert.equal(roots.length, 1, `expected one ${rootName} segment, got ${roots.length}`);
  const root = roots[0];
  return { root, all: spans.filter((s) => s.trace_id === root.trace_id) };
}

function childrenOf(all: Shipped[], parent: Shipped): Shipped[] {
  return all.filter((s) => s.parent_span_id === parent.span_id);
}

function one(all: Shipped[], name: string): Shipped {
  const found = all.filter((s) => s.name === name);
  assert.equal(found.length, 1, `expected one ${name}, got ${found.length}`);
  return found[0];
}

// Guard sweep 13 checks the call sites; this checks what actually shipped.
// Nothing in the fixture's question or answer text may appear as a value.
function assertNoContent(all: Shipped[]) {
  for (const s of all) {
    for (const [k, v] of Object.entries(s.attributes)) {
      if (typeof v !== "string") continue;
      assert.ok(!v.includes(QUESTION) && !v.includes("stubbed answer"), `${s.name} ${k} carries text`);
    }
  }
}

before(async () => {
  app = await loadApp();
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (app.db.fragment as unknown as { end: () => Promise<void> }).end();
  await app.db.privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  spans.length = 0;
  generations = 0;
  user = await createUser(admin);

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('span corpus', ${user.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${sha256("span")}, 'the body', ${user.id}) returning id`;
  await admin`insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs
      (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model, batch_savings)
    values (${user.id}, ${corpus.id}, ${BASE_MODEL}, 500, 50, 3, ${LLM_MODEL},
            ${admin.json({ semanticCache: { serve: true } })})
    returning id`;
  // Serving is on so the second ask can be a hit; the first misses either way.
  configId = cfg.id;
  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${doc.id}, ${BASE_MODEL}, ${DIM}, 500, 50, ${SCORES.length}, ${cfg.id})
    returning id`;
  const ids: string[] = [];
  for (const [i, score] of SCORES.entries()) {
    const [row] = await admin<{ id: string }[]>`
      insert into ${admin(app.vectorStore.chunksTable(BASE_MODEL, DIM))}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      values (${doc.id}, ${run.id}, ${i}, ${`chunk ${i}`}, ${app.vectorStore.vectorLiteral(atCosine(score))}, ${cfg.id})
      returning id`;
    ids.push(row.id);
  }
  // The weakest chunk, overridden to outrank the rest: a real fusion with no
  // provider behind it.
  await admin`
    insert into config_chunk_overrides
      (config_id, source_chunk_id, piece_index, model, dimension, kind,
       text, token_start, token_end, embedding)
    values (${configId}, ${ids[5]}, 0, ${OVERRIDE_MODEL}, ${DIM}, 'model',
            null, null, null, ${`{${atCosine(0.95).join(",")}}`}::real[])`;
  // The cache key model is the base model, so this one vector is the probe's
  // key AND the retrieval query.
  await bankQuery(QUESTION, atCosine(1));
});

describe("the span tree of one ask()", () => {
  it("a miss: rag.ask → probe, retrieve → fuse, llm.chat; cost equals the ledger row", async () => {
    const result = await inScope(() => app.ask(QUESTION));
    assert.equal(result.answer, "a stubbed answer");
    assert.equal(generations, 1);

    const { root, all } = await shippedTree("rag.ask");
    assert.equal(root.parent_span_id, undefined);
    assert.equal(root.attributes["config.id"], configId);
    assert.equal(root.attributes["cache.outcome"], "miss");
    assert.equal(root.attributes["cache.tier"], "no-candidates");
    assert.equal(root.attributes["answer.tokens.in"], USAGE.input_tokens);
    assert.equal(root.attributes["answer.tokens.out"], USAGE.output_tokens);

    // Direct children, in the order the pipeline opens them.
    assert.deepEqual(
      childrenOf(all, root).map((s) => s.name),
      ["rag.cache.probe", "rag.retrieve", "llm.chat"],
    );

    const probe = one(all, "rag.cache.probe");
    assert.equal(probe.attributes["cache.tier"], "no-candidates");
    // The probe's key embed, resolved from the banked row: nothing bought.
    const embed = one(all, "rag.embed");
    assert.equal(embed.parent_span_id, probe.span_id);
    assert.equal(embed.attributes["embed.model"], BASE_MODEL);
    assert.equal(embed.attributes["embed.cache"], "disk");
    assert.equal(embed.attributes["embed.count"], 1);
    assert.equal(embed.attributes["embed.tokens"], undefined, "a cache hit bought no tokens");

    const retrieve = one(all, "rag.retrieve");
    assert.equal(retrieve.attributes["retrieve.k"], 3);
    assert.equal(retrieve.attributes["retrieve.lanes.fired"], `base,${OVERRIDE_MODEL}`);
    assert.equal(retrieve.attributes["retrieve.lanes.dark"], "");
    const fuse = one(all, "rag.retrieve.fuse");
    assert.equal(fuse.parent_span_id, retrieve.span_id);
    assert.equal(fuse.attributes["fuse.candidates"], SCORES.length);
    assert.equal(typeof fuse.attributes["fuse.ties"], "number");

    const chat = one(all, "llm.chat");
    assert.equal(chat.attributes["llm.provider"], "anthropic");
    assert.equal(chat.attributes["llm.model"], LLM_MODEL);
    assert.equal(chat.attributes["llm.tokens.in"], USAGE.input_tokens);
    assert.equal(chat.attributes["llm.tokens.out"], USAGE.output_tokens);
    assert.equal(chat.attributes["llm.cached_input"], USAGE.cache_read_input_tokens);

    // ONE SOURCE FOR COST: the span's number is the ledger row's number.
    const rows = await admin<{ cost_usd: string; input_tokens: string }[]>`
      select cost_usd::text, input_tokens::text from provider_key_usage
      where user_id = ${user.id} and kind = 'message'`;
    assert.equal(rows.length, 1);
    assert.equal(chat.attributes["llm.cost.usd"], Number(rows[0].cost_usd));
    assert.equal(Number(rows[0].input_tokens), USAGE.input_tokens);
    // 1200 in × $1/M + 80 out × $5/M, Haiku 4.5's rate card.
    assert.ok(Math.abs(Number(rows[0].cost_usd) - 0.0016) < 1e-9);

    assert.ok(all.every((s) => s.status !== "error"), "no span in a clean ask may error");
    assertNoContent(all);
  });

  it("a hit: the second ask is served from the probe, with no retrieve and no llm.chat", async () => {
    await inScope(() => app.ask(QUESTION));
    assert.ok(await app.flushSentry());
    spans.length = 0;

    const again = await inScope(() => app.ask(QUESTION));
    assert.equal(again.answer, "a stubbed answer");
    assert.equal(generations, 1, "a served hit must not generate");

    const { root, all } = await shippedTree("rag.ask");
    assert.equal(root.attributes["cache.outcome"], "hit-exact");
    assert.equal(root.attributes["cache.tier"], "served");
    assert.deepEqual(childrenOf(all, root).map((s) => s.name), ["rag.cache.probe"]);
    const probe = one(all, "rag.cache.probe");
    assert.ok(Number(probe.attributes["cache.sim"]) > 0.999);
    assert.equal(probe.attributes["cache.threshold"], 0.95);
    assert.equal(probe.attributes["cache.entity_guard"], "pass");
    // The key embed was an in-process hit this time.
    assert.equal(one(all, "rag.embed").attributes["embed.cache"], "hit");
    assertNoContent(all);
  });
});

describe("the span tree of an eval batch", () => {
  it("rag.retrieve.prefetch, then one rag.retrieve → fuse per question, all under the caller", async () => {
    const other = "a second wording";
    await bankQuery(other, atCosine(0.99));
    const questions = [
      { text: QUESTION, vector: atCosine(1) },
      { text: other, vector: atCosine(0.99) },
    ];

    await inScope(async () => {
      const { buildRetrievalContext, prefetchRetrieval, retrieveWithCutoffs } = app.retriever;
      await app.span("eval.score", { "eval.questions": questions.length }, async () => {
        const ctx = await buildRetrievalContext();
        await prefetchRetrieval(ctx, questions, 3);
        for (const q of questions) await retrieveWithCutoffs(q.text, q.vector, 3, ctx);
      });
    });

    const { root, all } = await shippedTree("eval.score");
    assert.deepEqual(
      childrenOf(all, root).map((s) => s.name),
      ["rag.retrieve.prefetch", "rag.retrieve", "rag.retrieve"],
    );
    const prefetch = one(all, "rag.retrieve.prefetch");
    assert.equal(prefetch.attributes["prefetch.questions"], 2);
    // env.ts turns the statement meter on for the whole tier.
    assert.ok(Number(prefetch.attributes["prefetch.round_trips"]) > 0);

    for (const r of all.filter((s) => s.name === "rag.retrieve")) {
      assert.deepEqual(childrenOf(all, r).map((s) => s.name), ["rag.retrieve.fuse"]);
    }
    assertNoContent(all);
  });
});
