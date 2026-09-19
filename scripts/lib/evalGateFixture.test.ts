import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VectorBlob,
  chunkKey,
  decodeVectorSend,
  fixtureHash,
  manifestProblems,
  readVec,
  serializeManifest,
  type Manifest,
} from "./evalGateFixture";

const BASE = "voyage-4-lite";
const FOREIGN = "voyage-law-2";

// Two chunks, one foreign override, one question: the smallest fixture that has
// every kind of reference in it.
function fixture(): { manifest: Manifest; blob: Buffer } {
  const blob = new VectorBlob();
  const v = (...xs: number[]) => blob.add(Float32Array.from(xs));
  const a = chunkKey("a.md", 0);
  const b = chunkKey("a.md", 1);
  const manifest: Manifest = {
    version: 1,
    exportedAt: "2026-09-19T00:00:00.000Z",
    sourceConfigId: "cfg",
    fixtureHash: "",
    config: { baseModel: BASE, dimension: 2, chunkSize: 512, chunkOverlap: 50, topK: 5, fusionPool: null, recallK: null, mrrK: null, ndcgK: null },
    foreignModels: [FOREIGN],
    split: { mode: "pct", size: 25, seed: 1, candidates: 4, splitKey: "abc" },
    documents: [{ fileName: "a.md", contentHash: "h", content: "body" }],
    chunks: [
      { key: a, document: "a.md", position: 0, text: "one", vec: v(1, 0) },
      { key: b, document: "a.md", position: 1, text: "two", vec: v(0, 1) },
    ],
    overrides: [
      { chunk: a, pieceIndex: 0, model: FOREIGN, dimension: 3, kind: "model", text: null, tokenStart: null, tokenEnd: null, vec: v(1, 2, 3) },
    ],
    poolDocs: [
      { model: FOREIGN, chunk: a, vec: v(0.5, 0.25, 0.125) },
      { model: FOREIGN, chunk: b, vec: v(4, 5, 6) },
    ],
    questions: [
      { question: "which?", difficulty: "easy", expectedAnswer: null, source: a, truth: [a, b], qvec: { [BASE]: v(1, 1), [FOREIGN]: v(7, 8, 9) } },
    ],
  };
  return { manifest, blob: blob.toBuffer() };
}

describe("the eval gate fixture", () => {
  it("round-trips every vector through the blob by offset", () => {
    const { manifest, blob } = fixture();
    assert.deepEqual([...readVec(blob, manifest.chunks[1].vec)], [0, 1]);
    assert.deepEqual([...readVec(blob, manifest.poolDocs[0].vec)], [0.5, 0.25, 0.125]);
    assert.deepEqual([...readVec(blob, manifest.questions[0].qvec[FOREIGN])], [7, 8, 9]);
    assert.throws(() => readVec(blob, [blob.length / 4 - 1, 2]), /outside the blob/);
  });

  it("keeps a float32 exactly, not approximately", () => {
    const blob = new VectorBlob();
    const x = Math.fround(0.1);
    const ref = blob.add(Float32Array.of(x));
    assert.equal(readVec(blob.toBuffer(), ref)[0], x);
  });

  it("decodes pgvector's binary send format", () => {
    const buf = Buffer.alloc(4 + 8);
    buf.writeUInt16BE(2, 0);
    buf.writeFloatBE(0.5, 4);
    buf.writeFloatBE(-2, 8);
    assert.deepEqual([...decodeVectorSend(buf.toString("base64"))], [0.5, -2]);
    assert.throws(() => decodeVectorSend(buf.subarray(0, 8).toString("base64")), /expected 12/);
  });

  it("hashes to a new identity when one float changes", () => {
    const { manifest, blob } = fixture();
    const before = fixtureHash(manifest, blob);
    const nudged = Buffer.from(blob);
    nudged.writeFloatLE(nudged.readFloatLE(0) + 1e-3, 0);
    assert.notEqual(fixtureHash(manifest, nudged), before);
  });

  it("hashes the data, not the moment it was exported", () => {
    const { manifest, blob } = fixture();
    const before = fixtureHash(manifest, blob);
    assert.equal(fixtureHash({ ...manifest, exportedAt: "later", fixtureHash: "stale" }, blob), before);
    assert.notEqual(fixtureHash({ ...manifest, split: { ...manifest.split, seed: 2 } }, blob), before);
  });

  it("accepts a whole fixture", () => {
    const { manifest, blob } = fixture();
    assert.deepEqual(manifestProblems(manifest, blob.length / 4), []);
  });

  it("rejects a dangling chunk key wherever it appears", () => {
    const { manifest, blob } = fixture();
    const ghost = chunkKey("a.md", 9);
    manifest.questions[0].truth.push(ghost);
    manifest.overrides[0].chunk = ghost;
    const problems = manifestProblems(manifest, blob.length / 4);
    assert.ok(problems.some((p) => p.includes("truth names unknown chunk a.md#9")), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("override a.md#9") && p.includes("unknown chunk")));
  });

  // The failure this file exists for: the retriever reads a missing vector as a
  // cache miss and scores on with the lane dark.
  it("rejects a foreign lane with a hole in its pool or its queries", () => {
    const { manifest, blob } = fixture();
    manifest.poolDocs.pop();
    delete manifest.questions[0].qvec[FOREIGN];
    const problems = manifestProblems(manifest, blob.length / 4);
    assert.ok(problems.includes(`poolDoc ${FOREIGN}/a.md#1: missing`), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes(`no query vector under ${FOREIGN}`)));
  });

  it("rejects a vector of the wrong width", () => {
    const { manifest, blob } = fixture();
    manifest.overrides[0].dimension = 4;
    assert.ok(manifestProblems(manifest, blob.length / 4).some((p) => p.includes("3 wide, expected 4")));
  });

  it("serializes one record per line and parses back to itself", () => {
    const { manifest } = fixture();
    const text = serializeManifest(manifest);
    assert.deepEqual(JSON.parse(text), manifest);
    assert.equal(text.split("\n").filter((l) => l.includes('"key":')).length, manifest.chunks.length);
  });
});
