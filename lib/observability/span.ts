// The one door for pipeline spans (docs/obs-5-pipeline-spans-plan.md §1). Spans
// ride Sentry's own OpenTelemetry tracer — never a second SDK — so they land in
// Sentry's waterfall under the request's transaction.
//
// Span names and attribute keys are a contract O6 reads; the table in §1 is the
// list. Attribute values are ids, numbers and enums ONLY: never question, answer
// or chunk text, never a key.
//
// Safe with Sentry uninitialised (no DSN): startSpan then hands back a
// non-recording span and setAttribute on it does nothing.
import * as Sentry from "@sentry/nextjs";

export type AttrValue = string | number | boolean;
// `undefined` is dropped rather than sent, so a call site can pass an optional
// value without a guard of its own.
export type Attrs = Record<string, AttrValue | undefined>;

export type SpanHandle = { setAttr(key: string, value: AttrValue | undefined): void };

function defined(attrs: Attrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

export function span<T>(
  name: string,
  attrs: Attrs,
  fn: (s: SpanHandle) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan({ name, op: name, attributes: defined(attrs) }, (s) =>
    fn({
      setAttr: (key, value) => {
        if (value !== undefined) s.setAttribute(key, value);
      },
    }),
  );
}

// On whichever span is current — for a value known only deep inside a callee.
export function setAttr(key: string, value: AttrValue | undefined): void {
  if (value !== undefined) Sentry.getActiveSpan()?.setAttribute(key, value);
}
