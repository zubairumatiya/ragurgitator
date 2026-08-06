// ---------------------------------------------------------------------------
// MISSING-KEY WIRE CONTRACT — the shape a route uses to say "this request was
// fine, you just have no key for the provider it needs" (docs/user-accounts-plan.md §5).
//
// Under strict BYOK there are no server keys, so EVERY user hits this on their
// first run: it is the app's most common failure, not an edge case, and the one
// where the difference between "add your OpenAI key" (a link) and "OpenAI
// rejected the request" (a support problem) matters most. MissingProviderKeyError
// carries the provider precisely so that distinction survives to the client;
// before this module nothing consumed it and it arrived as a 500 with the
// sentence buried in a generic message.
//
// TWO TRANSPORTS, ONE PAYLOAD. Plain routes return JSON from the scope wrappers
// in configScope.ts; the NDJSON routes own their error handling by contract (see
// ndjson.ts) and emit a typed event instead. Both build their body here so the
// client has one thing to recognise.
//
// CLIENT-SAFE ON PURPOSE — no `server-only`, no import of lib/llm/client (which
// is server-only). This module is the shared vocabulary; the server-side
// detection lives in missingKeyServer.ts, which may import both.
// ---------------------------------------------------------------------------

// The machine-readable discriminator. A CODE rather than string-matching the
// message: the message is prose that will be reworded, and a client keying off
// it would break silently and only for users who are already stuck.
export const MISSING_PROVIDER_KEY = "missing_provider_key";

// Fields added to an error body/event when the cause was a missing key. Optional
// so an ordinary error carries neither, and `code` is the literal type so a
// `code === MISSING_PROVIDER_KEY` check narrows.
export type MissingKeyFields = {
  provider?: string;
  code?: typeof MISSING_PROVIDER_KEY;
};

// The JSON body of the 400. `error` stays the plain message so a client that
// knows nothing about this contract still shows something true.
export type MissingKeyBody = { error: string } & MissingKeyFields;

// The NDJSON event. The four streaming event unions (IngestEvent, EvalEvent,
// ClusterEvent, AutotuneEvent) all spell their error case as this type, so
// widening the payload once widens it for every stream.
export type StreamErrorEvent = { type: "error"; message: string } & MissingKeyFields;

// Does a parsed response body / stream event describe a missing key? The CLIENT
// side of the contract — takes an unknown parsed blob, so a component can ask
// without importing anything server-side.
export function isMissingKeyPayload(
  body: unknown,
): body is MissingKeyFields & { provider: string } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as MissingKeyFields;
  return b.code === MISSING_PROVIDER_KEY && typeof b.provider === "string";
}

// Where the user has to go, in one place — the component and the plain-string
// surfaces both quote it, so a route change moves both.
export const ACCOUNT_PATH = "/account";

// The message for a missing key, phrased as the action that fixes it, or null
// when this isn't one.
//
// It exists because most of this app's error state is a STRING (a chat bubble, a
// panel's `message` field) with nowhere to hang a link. Those surfaces still name
// the provider and the page; the ones that render JSX use <MissingKeyNotice> and
// get a real link. Both read the same payload, so they cannot disagree about what
// went wrong — only about how much they can do about it.
export function missingKeyMessage(body: unknown): string | null {
  if (!isMissingKeyPayload(body)) return null;
  return `No ${body.provider} API key — add one on the Account page (${ACCOUNT_PATH}) to use this.`;
}

// The text to show for any error payload: the missing-key phrasing when that's
// what it is, else the body's own `error`/`message`, else `fallback`.
export function errorTextFrom(body: unknown, fallback: string): string {
  const missing = missingKeyMessage(body);
  if (missing) return missing;
  const b = (body ?? {}) as { error?: unknown; message?: unknown };
  if (typeof b.error === "string" && b.error) return b.error;
  if (typeof b.message === "string" && b.message) return b.message;
  return fallback;
}
