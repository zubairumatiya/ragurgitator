// Edge-runtime Sentry init, loaded from instrumentation.ts register(). Nothing runs on the
// edge today (proxy.ts defaults to Node in Next 16); this is here so a route that
// opts into `runtime = "edge"` is not silently unmonitored.
//
// Skipped entirely when SENTRY_DSN is unset — that is the CI build and any local
// checkout without a Sentry project, and neither may send or warn.
import * as Sentry from "@sentry/nextjs";
import { dataCollection } from "./sentry.base.config";
import { tracesSamplerFor } from "./lib/observability/sampler";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    // Preview traffic is us; production is mostly the public demo, and the free
    // plan's span quota is small. A child keeps its parent's decision.
    tracesSampler: tracesSamplerFor(process.env.VERCEL_ENV),
    dataCollection,
  });
}
