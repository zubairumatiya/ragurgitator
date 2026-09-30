import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordStatement, statementMeter, statementPrefix } from "./statementMeter";

describe("statementPrefix", () => {
  it("names the keyword and the first table", () => {
    assert.equal(statementPrefix("select id, text\n  from chunks_voyage_4_1024 ch join documents d on true"), "select chunks_voyage_4_1024");
    assert.equal(statementPrefix("insert into eval_results (a) values ($1)"), "insert eval_results");
    assert.equal(statementPrefix('update "configs" set x = $1'), "update configs");
    assert.equal(statementPrefix("DELETE FROM public.jobs where id = $1"), "delete public.jobs");
  });

  it("falls back to the keyword alone when there is no table", () => {
    assert.equal(statementPrefix("begin"), "begin");
    assert.equal(statementPrefix("select set_config('app.user_id', $1, true)"), "select");
    assert.equal(statementPrefix("set local hnsw.ef_search = 40; set local hnsw.iterative_scan = strict_order"), "set");
  });

  it("a subquery is not a table, and comments are not statements", () => {
    assert.equal(statementPrefix("with x as (select 1) select * from (select 1) s, overrides o"), "with");
    assert.equal(statementPrefix("-- a comment from nowhere\nselect * from embedding_cache"), "select embedding_cache");
  });
});

describe("statementMeter", () => {
  it("counts per prefix, sorts the snapshot, and resets", () => {
    statementMeter.reset();
    recordStatement("select * from b");
    recordStatement("select * from a");
    recordStatement("select * from b");
    recordStatement("begin");
    assert.deepEqual(statementMeter.snapshot(), { total: 4, byPrefix: { "select b": 2, begin: 1, "select a": 1 } });
    assert.deepEqual(Object.keys(statementMeter.snapshot().byPrefix), ["select b", "begin", "select a"]);
    statementMeter.reset();
    assert.deepEqual(statementMeter.snapshot(), { total: 0, byPrefix: {} });
  });

  it("never keeps parameters", () => {
    statementMeter.reset();
    recordStatement("select * from users where email = 'secret@example.com'");
    assert.equal(JSON.stringify(statementMeter.snapshot()).includes("secret"), false);
    statementMeter.reset();
  });
});
