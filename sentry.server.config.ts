// Node-runtime Sentry init, loaded from instrumentation.ts register().
//
// Skipped entirely when SENTRY_DSN is unset — that is the CI build and any local
// checkout without a Sentry project, and neither may send or warn.
import * as Sentry from "@sentry/nextjs";
import { dataCollection } from "./sentry.base.config";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    // Preview traffic is us; production is mostly the public demo, and the free
    // plan's span quota is small.
    tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.2 : 1.0,
    dataCollection,
  });
}
