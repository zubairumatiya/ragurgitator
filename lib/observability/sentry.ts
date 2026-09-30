// The one door app code uses to reach Sentry. lib/ and app/ import this, never
// @sentry/nextjs — scripts/guards.ts sweep 11 enforces it — so the vendor can be
// swapped in one file and a test can install its own transport through initSentry.
//
// Every export is safe with Sentry uninitialised (no DSN: CI, local checkouts):
// the SDK's calls are then no-ops, which is what Trap 2 in docs/obs-1-sentry-plan.md
// §0 requires.
//
// TAGS COME FROM OUR OWN REQUEST CONTEXT, NEVER FROM A SENTRY SCOPE. The first
// version of this file wrote user/config/route onto Sentry's isolation scope and
// let events inherit them. On Vercel that scope is not per-request: a job-secret
// route's capture carried a demo guest's ids from a request two minutes earlier,
// and the events Next's onRequestError produces never saw the handler's tags at
// all (plan, "Phase 4 follow-up", 2026-09-30). Local dev shows neither, which is
// why it shipped. lib/log's AsyncLocalStorage context already holds exactly these
// ids, is entered by every scope boundary, and is what the NDJSON producer and the
// detached queue re-bind — so captureException reads it and sends the ids as
// explicit event tags. Nothing here calls scope.setTag.
import * as Sentry from "@sentry/nextjs";

import { logContext } from "../log";
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

// The ids of the current request as event tags. Ids only: never a provider key,
// never a request body. Absent fields are absent tags, so a capture outside any
// scope (a script, a cold job slice) carries nothing it should not.
export function requestTags(): Record<string, string> {
  const ctx = logContext();
  const tags: Record<string, string> = {};
  if (ctx.userId) tags["user.id"] = ctx.userId;
  if (ctx.guest) tags.guest = "true";
  if (ctx.configId) tags["config.id"] = ctx.configId;
  if (ctx.route) tags.route = ctx.route;
  if (ctx.jobId) tags["job.id"] = ctx.jobId;
  return tags;
}

// Errors this module has already reported, so Next's onRequestError (which sees
// every error that escapes a handler, including ones a scope boundary captured on
// the way out) does not report them twice. A WeakSet, so nothing is retained.
const captured = new WeakSet<object>();

export function wasCaptured(err: unknown): boolean {
  return typeof err === "object" && err !== null && captured.has(err);
}

// Returns the event id, which is what a log line or the verification log names.
export function captureException(err: unknown, ctx: CaptureContext = {}): string {
  if (typeof err === "object" && err !== null) captured.add(err);
  return Sentry.captureException(err, {
    tags: { ...requestTags(), ...ctx.tags },
    extra: ctx.extra,
  });
}

// What instrumentation.ts exports as onRequestError. Next calls it for errors that
// escape a route handler, page, layout or server action. The scope boundaries
// (lib/observability/escapes.ts) have already captured — with the request's ids —
// anything that escaped through them, so those are skipped here; what remains is
// tagged with the path Next hands over, which is all this hook can know.
export const onRequestError: typeof Sentry.captureRequestError = (err, request, ctx) => {
  if (wasCaptured(err)) return;
  Sentry.withScope((scope) => {
    scope.setTag("route", request.path);
    Sentry.captureRequestError(err, request, ctx);
  });
};

// Tests and short-lived scripts exit before the transport's queue drains.
export function flushSentry(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
