// Loads an embedding model's tokenizer from the HF Hub, WITHOUT going through
// @huggingface/transformers.
//
// WHY THIS FILE EXISTS. transformers.js@4's Node entry does a static, top-level
// `import * as ONNX_NODE from "onnxruntime-node"`, so importing AutoTokenizer —
// which is pure JS and all the chunker ever wanted — drags a 26 MB native
// runtime into the serverless bundle. @vercel/nft cannot trace that runtime's
// platform binary (its path is built at runtime), so every route that touched
// the chunker 500'd in production on a missing libonnxruntime.so.1. See
// docs/serverless-bundle-fix-plan.md.
//
// @huggingface/tokenizers is the same implementation, not a lookalike:
// transformers.js@4 INLINES this exact package into its own dist. Same token
// ids, same decode — which is the only thing that matters here, because a
// shifted tokenization shifts every chunk boundary after it, and the vectors
// already stored against those documents were embedded at the old boundaries.
// lib/rag/tokenizerLoader.test.ts pins that equality against fixtures captured
// from the pre-swap AutoTokenizer.
//
// What we give up: Tokenizer's constructor takes already-parsed JSON and has no
// Hub loader, so the fetch + cache that from_pretrained did for us lives here
// now.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Tokenizer } from "@huggingface/tokenizers";

// The two files a Hub tokenizer repo is made of. Both are required: a missing
// tokenizer_config.json changes decode behaviour (clean-up rules, special
// tokens) rather than merely losing a nicety, and silently tokenizing
// differently is the one failure this module exists to prevent.
const FILES = ["tokenizer.json", "tokenizer_config.json"] as const;

// Where downloaded tokenizer files live between invocations.
//
// Same reasoning as lib/rag/transformersCache.ts, for the same reason: on a
// serverless host node_modules is read-only and /tmp is the only writable path,
// and it survives for the life of the instance so warm invocations reuse the
// download. Locally we keep it inside node_modules/.cache, which persists across
// runs rather than dying with the container.
//
// TOKENIZER_CACHE_DIR overrides both. The unit test points it at the vendored
// fixture directory, so the test exercises this loader's real path — cache hit,
// parse, construct — without ever reaching the Hub.
function cacheDir(): string {
  const override = process.env.TOKENIZER_CACHE_DIR;
  if (override) return override;
  return process.env.VERCEL
    ? "/tmp/tokenizer-cache"
    : join(process.cwd(), "node_modules/.cache/huggingface-tokenizers");
}

function readCached(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return null;
  }
}

// Write via a temp file + rename so a concurrent reader never sees a half-written
// tokenizer.json. Cache writes are best-effort: a read-only or full disk should
// cost us the cache, not the request.
function writeCached(dir: string, file: string, body: string) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${file}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(dir, file));
  } catch (err) {
    console.warn(`[rag:tokenizer] could not cache ${file} in ${dir}: ${err}`);
  }
}

async function fetchFile(repo: string, file: string): Promise<string> {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    // Loud on purpose. The alternative — falling back to some other tokenizer,
    // or to no tokenizer — would re-chunk a document differently from the
    // vectors already stored against it, and nothing downstream would catch it.
    throw new Error(`Tokenizer download failed: ${url} returned HTTP ${res.status}`);
  }
  return res.text();
}

async function build(model: string): Promise<Tokenizer> {
  const repo = `voyageai/${model}`;
  const dir = join(cacheDir(), model);

  const [tokenizerJson, configJson] = await Promise.all(
    FILES.map(async (file) => {
      const cached = readCached(dir, file);
      if (cached !== null) return cached;
      const body = await fetchFile(repo, file);
      writeCached(dir, file, body);
      return body;
    }),
  );

  return new Tokenizer(JSON.parse(tokenizerJson), JSON.parse(configJson));
}

// Cached per model on first use, then reused: different configs can use
// different embedding models, so we can't share one tokenizer. The PROMISE is
// cached, not the resolved value, so concurrent callers on a cold instance share
// one download instead of racing.
const tokenizers = new Map<string, Promise<Tokenizer>>();

export function loadTokenizer(model: string): Promise<Tokenizer> {
  let promise = tokenizers.get(model);
  if (!promise) {
    promise = build(model).catch((err) => {
      // Don't cache a failure: a Hub blip on one cold request should not
      // poison the model for the life of the instance.
      tokenizers.delete(model);
      throw err;
    });
    tokenizers.set(model, promise);
  }
  return promise;
}

export type { Tokenizer };
