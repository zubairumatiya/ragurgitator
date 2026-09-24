// The one door app code uses to reach Sentry. lib/ and app/ import this, never
// @sentry/nextjs — scripts/guards.ts sweep 11 enforces it — so the vendor can be
// swapped in one file and a test can install its own transport through initSentry.
//
// Every export is safe with Sentry uninitialised (no DSN: CI, local checkouts):
// the SDK's calls are then no-ops, which is what Trap 2 in docs/obs-1-sentry-plan.md
// §0 requires.
import * as Sentry from "@sentry/nextjs";

import { dataCollection } from "../../sentry.base.config";

type InitOptions = {
  dsn: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  // For tests: a transport that keeps envelopes in memory. Sentry accepts a
  // syntactically valid dummy DSN when one is supplied, so nothing leaves the process.
  transport?: NonNullable<Parameters<typeof Sentry.init>[0]>["transport"];
};

export function initSentry(options: InitOptions): void {
  Sentry.init({ ...options, dataCollection });
}

export type CaptureContext = {
  tags?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
};

// Returns the event id, which is what a log line or the verification log names.
export function captureException(err: unknown, ctx: CaptureContext = {}): string {
  return Sentry.captureException(err, { tags: ctx.tags, extra: ctx.extra });
}

export type RequestTags = {
  userId?: string;
  guest?: boolean;
  configId?: string;
  route?: string;
};

// Tags land on the isolation scope — per request under Next's instrumentation — so
// every later capture in the request carries them without being passed them.
// Ids only: never a provider key, never a request body.
export function setRequestTags(tags: RequestTags): void {
  const scope = Sentry.getIsolationScope();
  if (tags.userId) scope.setTag("user.id", tags.userId);
  if (tags.guest) scope.setTag("guest", "true");
  if (tags.configId) scope.setTag("config.id", tags.configId);
  if (tags.route) scope.setTag("route", tags.route);
}

// Tests and short-lived scripts exit before the transport's queue drains.
export function flushSentry(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
