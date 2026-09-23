import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VectorBlob, fixtureHash, manifestProblems, serializeManifest, textHash, textsOf, type Manifest } from "./cacheGateFixture";

// One generated pair, one shadow row sharing a text with it: the smallest
// fixture with every kind of reference in it.
function fixture(): { manifest: Manifest; blob: Buffer } {
  const blob = new VectorBlob();
  const v = (...xs: number[]) => blob.add(Float32Array.from(xs));
  const a = "what is a";
  const b = "what is a?";
  const c = "what is b";
  const manifest: Manifest = {
    version: 1,
    exportedAt: "2026-09-23T00:00:00.000Z",
    sourceConfigId: "cfg",
    fixtureHash: "",
    keyModel: "voyage-4-lite",
    keyModelSource: "config",
    space: "voyage-4",
    dimension: 2,
    tau: { value: 0.95, source: "config" },
    generated: [{ textA: a, textB: b, label: "same", difficulty: "paraphrase", verdict: null, verdictSource: null }],
    shadow: [{ textA: c, textB: a, verdict: "reject", origin: "probe", simAtCapture: 0.96, guardBlockedAtCapture: false }],
    vectors: { [textHash(a)]: v(1, 0), [textHash(b)]: v(0.9, 0.1), [textHash(c)]: v(0, 1) },
  };
  const bytes = blob.toBuffer();
  manifest.fixtureHash = fixtureHash(manifest, bytes);
  return { manifest, blob: bytes };
}

describe("cache gate fixture", () => {
  it("a complete fixture has no problems", () => {
    const { manifest, blob } = fixture();
    assert.deepEqual(manifestProblems(manifest, blob.length / 4), []);
    assert.equal(textsOf(manifest).size, 3);
  });

  it("names every text without a vector, and every vector without a text", () => {
    const { manifest, blob } = fixture();
    const { [textHash("what is b")]: dropped, ...rest } = manifest.vectors;
    const m = { ...manifest, vectors: { ...rest, deadbeef: dropped } };
    const problems = manifestProblems(m, blob.length / 4);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /"what is b": no vector under voyage-4-lite/);
    assert.match(problems[1], /vectors: deadbeef.*belongs to no row/);
  });

  it("catches a truncated blob and a wrong width", () => {
    const { manifest, blob } = fixture();
    assert.match(manifestProblems(manifest, blob.length / 4 - 1)[0], /outside the blob/);
    assert.match(manifestProblems({ ...manifest, dimension: 3 }, blob.length / 4)[0], /is 2 wide, expected 3/);
  });

  it("refuses empty sets, a self-pair and a duplicate pair", () => {
    const { manifest, blob } = fixture();
    const g = manifest.generated[0];
    const m = { ...manifest, generated: [g, { ...g, textA: g.textB, textB: g.textA }, { ...g, textB: g.textA }], shadow: [] };
    const problems = manifestProblems(m, blob.length / 4);
    assert.match(problems[0], /shadow: no judged rows/);
    assert.match(problems[1], /duplicate pair/, "orientation does not make a new pair");
    assert.match(problems[2], /text with itself/);
  });

  it("hash ignores exportedAt and itself, not the data", () => {
    const { manifest, blob } = fixture();
    assert.equal(fixtureHash({ ...manifest, exportedAt: "2027-01-01T00:00:00.000Z", fixtureHash: "x" }, blob), manifest.fixtureHash);
    assert.notEqual(fixtureHash({ ...manifest, tau: { value: 0.9, source: "config" } }, blob), manifest.fixtureHash);
  });

  it("serializes one record per line and round-trips", () => {
    const { manifest } = fixture();
    const text = serializeManifest(manifest);
    assert.match(text, /\n  "generated": \[\n    \{"textA"/);
    assert.deepEqual(JSON.parse(text), manifest);
  });
});
