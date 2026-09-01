// THE PICKER'S TEXT READ, and how much of it comes back (docs/demo-egress-plan.md §1.6).
//
// Phase 5 narrows `getRankingChunks` to `left(c.text, 200)`, because every caller
// that puts this text on a screen trims it harder than that anyway. The saving is
// bytes on the pooler wire, which no unit test can see, so what this file asserts
// is the observable consequence:
//
//   1. The default read returns EXACTLY `text.slice(0, PREVIEW_TEXT_CHARS)` —
//      not merely "shorter", so a later lap that changes the length has to change
//      this number too.
//   2. `{ fullText: true }` still returns the whole text. That opt-out is not
//      cosmetic: ranking.ts feeds those rows to the LLM ranker, and a truncated
//      prompt would change the ranking rather than just the bill.
//
// It needs a real database because the truncation is done by Postgres, and
// because getRankingChunks is three joins and a config scope. No provider is ever
// called — nothing here embeds.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { PREVIEW_TEXT_CHARS, getRankingChunks } from "../../lib/rag/rankingStore";
import { chunksTable, vectorLiteral } from "../../lib/rag/vectorStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const BASE_MODEL = "voyage-4-lite";
const DIM = 1024;
const CHUNKS = chunksTable(BASE_MODEL, DIM);

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// Comfortably longer than the preview, and non-repeating, so a truncation at the
// wrong offset cannot accidentally produce the expected string.
const LONG = Array.from({ length: 400 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
// Shorter than the preview: left(text, n) must leave it alone.
const SHORT = "tiny chunk";

let admin: Sql;
let user: { id: string; email: string };
let configId: string;
let longId: string;
let shortId: string;

async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return withUser(user, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  user = await createUser(admin);

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('preview corpus', ${user.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${sha256("a")}, 'the body', ${user.id}) returning id`;
  await admin`
    insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${user.id}, ${corpus.id}, ${BASE_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;

  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${doc.id}, ${BASE_MODEL}, ${DIM}, 500, 50, 2, ${cfg.id})
    returning id`;

  const unit = new Array(DIM).fill(0);
  unit[0] = 1;
  const ids: string[] = [];
  for (const [i, text] of [LONG, SHORT].entries()) {
    const [row] = await admin<{ id: string }[]>`
      insert into ${admin(CHUNKS)}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      values (${doc.id}, ${run.id}, ${i}, ${text}, ${vectorLiteral(unit)}, ${cfg.id})
      returning id`;
    ids.push(row.id);
  }
  [longId, shortId] = ids;
});

describe("getRankingChunks text width", () => {
  it("returns exactly text.slice(0, PREVIEW_TEXT_CHARS) by default", async () => {
    const chunks = await inScope(() => getRankingChunks([longId, shortId]));

    assert.equal(PREVIEW_TEXT_CHARS, 200, "the picker preview length is a stated constant");
    assert.equal(chunks.get(longId)?.text, LONG.slice(0, PREVIEW_TEXT_CHARS));
    // A row already under the limit passes through untouched, so the narrowing
    // never turns a whole chunk into a suspiciously round 200 characters.
    assert.equal(chunks.get(shortId)?.text, SHORT);
  });

  it("returns whole text under { fullText: true }", async () => {
    const chunks = await inScope(() => getRankingChunks([longId, shortId], { fullText: true }));

    assert.equal(chunks.get(longId)?.text, LONG);
    assert.equal(chunks.get(shortId)?.text, SHORT);
  });

  it("labels a chunk the same either way", async () => {
    const [preview, full] = await inScope(async () => [
      await getRankingChunks([longId]),
      await getRankingChunks([longId], { fullText: true }),
    ]);

    assert.equal(preview.get(longId)?.fileName, full.get(longId)?.fileName);
    assert.equal(preview.get(longId)?.position, full.get(longId)?.position);
  });
});
