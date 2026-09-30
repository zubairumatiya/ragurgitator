// The server's trace sampler (docs/obs-5-pipeline-spans-plan.md §0). Span volume
// is what eats a free quota: preview and local traffic is us, so all of it;
// production is mostly the public demo, so a fifth.
//
// A child keeps its parent's decision (inheritOrSampleWith), so one request is
// never half a waterfall. Error EVENTS are not sampled by this at all — they go
// through sampleRate, which is 1.0 — so every error still reaches Sentry; what a
// sampled-out request lacks is only its waterfall. See DECISIONS in the plan.
//
// Pure, no Sentry import: sentry.server.config.ts and the edge config pass it
// straight to init, and the unit test calls it with a hand-built context.
export const PRODUCTION_TRACE_RATE = 0.2;

type Context = { inheritOrSampleWith: (fallbackSampleRate: number) => number };

export function traceRateFor(vercelEnv: string | undefined): number {
  return vercelEnv === "production" ? PRODUCTION_TRACE_RATE : 1.0;
}

export function tracesSamplerFor(vercelEnv: string | undefined) {
  const rate = traceRateFor(vercelEnv);
  return (ctx: Context): number => ctx.inheritOrSampleWith(rate);
}
