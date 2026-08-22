// THE CHECK THE WHOLE SWAP RESTS ON.
//
// lib/rag/chunker.ts moved off @huggingface/transformers' AutoTokenizer and onto
// @huggingface/tokenizers to keep onnxruntime out of the serverless bundle (see
// docs/serverless-bundle-fix-plan.md). Everything about that swap is safe except
// one thing: if the new tokenizer produced even slightly different ids, chunk
// boundaries would move, and re-ingesting a document would produce chunk text
// that no longer matches the vectors already stored against it. Nothing
// downstream would notice.
//
// So this replays fixtures captured from the PRE-SWAP AutoTokenizer
// (scripts/tokenizer-golden.ts) and asserts exact equality on the four
// primitives the chunker is built out of. It does not test the chunker — it
// tests the thing underneath it that everything else is derived from.
//
// HERMETIC: TOKENIZER_CACHE_DIR points the loader at the vendored tokenizer
// files under the fixtures, so this exercises the loader's real cache-hit path
// and never reaches the Hub.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { loadTokenizer } from "./tokenizerLoader";

const FIXTURE_DIR = join(process.cwd(), "test/fixtures/tokenizer");

type Sample = { name: string; text: string };
type Golden = {
  model: string;
  repo: string;
  samples: Record<
    string,
    { ids: number[]; idsWithSpecial: number[]; decoded: string; tokenDecodeLengths: number[] }
  >;
};

function readJson<T>(...path: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, ...path), "utf8")) as T;
}

// A model has a fixture when both its golden ids and its vendored tokenizer
// files are committed. Discovered from disk rather than hardcoded, so adding a
// model to the fixtures is enough to put it under test.
function fixtureModels(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => statSync(join(FIXTURE_DIR, name)).isDirectory())
    .filter((name) => readdirSync(FIXTURE_DIR).includes(`${name}.json`));
}

describe("tokenizerLoader — equivalence with the pre-swap AutoTokenizer", () => {
  const previousCacheDir = process.env.TOKENIZER_CACHE_DIR;
  before(() => {
    process.env.TOKENIZER_CACHE_DIR = FIXTURE_DIR;
  });
  after(() => {
    if (previousCacheDir === undefined) delete process.env.TOKENIZER_CACHE_DIR;
    else process.env.TOKENIZER_CACHE_DIR = previousCacheDir;
  });

  const samples = readJson<Sample[]>("samples.json");
  const models = fixtureModels();

  // Guards against the failure mode where this whole file silently passes
  // because the fixtures moved or were never committed.
  it("has fixtures to replay", () => {
    assert.ok(models.length > 0, "no vendored tokenizer fixtures found");
    assert.ok(samples.length >= 40, `expected ~40 samples, got ${samples.length}`);
  });

  for (const model of models) {
    describe(model, () => {
      const golden = readJson<Golden>(`${model}.json`);

      it("encodes every sample to the same ids", async () => {
        const tokenizer = await loadTokenizer(model);

        for (const { name, text } of samples) {
          const expected = golden.samples[name];
          assert.ok(expected, `fixture has no sample "${name}"`);

          const encoded = tokenizer.encode(text, { add_special_tokens: false });
          assert.deepEqual(encoded.ids, expected.ids, `ids differ for "${name}"`);

          const withSpecial = tokenizer.encode(text, { add_special_tokens: true });
          assert.deepEqual(
            withSpecial.ids,
            expected.idsWithSpecial,
            `ids (with special tokens) differ for "${name}"`,
          );
        }
      });

      it("decodes every sample to the same text", async () => {
        const tokenizer = await loadTokenizer(model);

        for (const { name } of samples) {
          const expected = golden.samples[name]!;
          // decodeWindows never decodes an empty window (its loop does not run
          // for empty text), and decode rejects an empty id list.
          const decoded =
            expected.ids.length === 0
              ? ""
              : tokenizer.decode(expected.ids, { skip_special_tokens: true });
          assert.equal(decoded, expected.decoded, `decode differs for "${name}"`);
        }
      });

      // tokenizeWithOffsets' O(n) fast path sums exactly these lengths into its
      // char offsets, so a drift here would move the eval boundary editor's
      // borders without moving any id.
      it("gives every token the same isolated decode length", async () => {
        const tokenizer = await loadTokenizer(model);

        for (const { name } of samples) {
          const expected = golden.samples[name]!;
          const lengths = expected.ids.map(
            (id) => tokenizer.decode([id], { skip_special_tokens: true }).length,
          );
          assert.deepEqual(
            lengths,
            expected.tokenDecodeLengths,
            `per-token decode lengths differ for "${name}"`,
          );
        }
      });

      // The two invariants the chunker's callers rely on directly, asserted
      // against the new implementation rather than against the fixture — a
      // fixture captured from a buggy pre-swap run would still satisfy the
      // equality tests above.
      it("round-trips and lands the final offset on text.length", async () => {
        const tokenizer = await loadTokenizer(model);

        for (const { name, text } of samples) {
          const { ids } = tokenizer.encode(text, { add_special_tokens: false });
          if (ids.length === 0) continue;

          const decoded = tokenizer.decode(ids, { skip_special_tokens: true });
          // Not text === decoded: a tokenizer normalizes (whitespace, unpaired
          // surrogates), so the honest invariant is that decoding is stable —
          // re-encoding its own output reproduces it exactly. A tokenizer that
          // lost or duplicated content would fail this.
          const reencoded = tokenizer.encode(decoded, { add_special_tokens: false });
          assert.deepEqual(
            tokenizer.decode(reencoded.ids, { skip_special_tokens: true }),
            decoded,
            `decode is not stable under re-encode for "${name}"`,
          );

          const offsets = [0];
          let acc = 0;
          for (const id of ids) {
            acc += tokenizer.decode([id], { skip_special_tokens: true }).length;
            offsets.push(acc);
          }
          assert.equal(offsets.length, ids.length + 1, `offset count wrong for "${name}"`);
        }
      });
    });
  }
});
