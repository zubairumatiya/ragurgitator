// Where transformers.js is allowed to write its downloaded weights.
//
// The default cacheDir is a directory INSIDE node_modules, which is read-only on
// a serverless host. /tmp is the only writable path there, and it survives for
// the life of the instance, so warm invocations reuse the download. Local
// machines keep the packaged default, where node_modules is writable and the
// cache persists across runs rather than dying with the container.
//
// A FUNCTION TAKING `env`, NOT A SIDE-EFFECT IMPORT. This used to be
// `import { env } from "@huggingface/transformers"` plus a top-level assignment,
// which callers had to import BEFORE anything that loaded a model — an ordering
// no type checks and nothing enforced. Worse, it silently assumed that this
// module and its caller resolve @huggingface/transformers to the same instance;
// the package ships both a .cjs and a .mjs build, and under a loader that picks
// them differently the assignment lands on one `env` object while the model
// loads against the other, putting the cache back inside node_modules with no
// error anywhere.
//
// Handing the caller's own `env` in makes both problems unrepresentable: there
// is one instance by construction, and the call happens where the model is
// loaded rather than in an import ordered by convention.

// `cacheDir: string | null` matches transformers' own
// TransformersEnvironment, so the caller can pass its `env` straight in.
type TransformersEnv = { cacheDir: string | null };

export function applyWritableCacheDir(env: TransformersEnv) {
  if (process.env.VERCEL) {
    env.cacheDir = "/tmp/transformers-cache";
  }
}
