// Browser Sentry init. Runs before hydration, so it stays small; skipped when
// NEXT_PUBLIC_SENTRY_DSN is unset (the CI build, and local checkouts without it).
import * as Sentry from "@sentry/nextjs";
import { dataCollection } from "./sentry.base.config";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    // The demo is the only public traffic and the free span quota is small.
    tracesSampleRate: 0.1,
    dataCollection,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
