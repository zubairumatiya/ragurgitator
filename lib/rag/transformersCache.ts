// Where transformers.js is allowed to write its downloaded weights.
//
// The default cacheDir is a directory INSIDE node_modules, which is read-only on
// a serverless host: chunking calls AutoTokenizer.from_pretrained on every ingest,
// so on Vercel the default either fails the write or silently re-downloads the
// tokenizer from the HF Hub on every cold start. /tmp is the only writable path
// there, and it survives for the life of the instance, so warm invocations reuse
// the download.
//
// Import this for its side effect BEFORE anything that loads a model. Local
// machines keep the packaged default, where node_modules is writable and the
// cache persists across runs rather than dying with the container.
import { env } from "@huggingface/transformers";

if (process.env.VERCEL) {
  env.cacheDir = "/tmp/transformers-cache";
}
