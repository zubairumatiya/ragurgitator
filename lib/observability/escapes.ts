// Capture an error on its way OUT of a scope boundary, while the request's ids are
// still in context, then let it keep escaping.
//
// Why here and not in Next's onRequestError: on Vercel that hook runs outside the
// handler's context, so by the time it fires the user, config and route are gone
// (docs/obs-1-sentry-plan.md, "Phase 4 follow-up"). The boundary is the last place
// that knows them. captureException marks the error, and onRequestError skips
// marked errors, so nothing is reported twice.
//
// Next's own control flow — redirect(), notFound(), a Request-time API called
// during a static render, a postponed or interrupted prerender — also arrives here
// as a thrown error and must pass through untouched. isNextControlFlow mirrors
// next/navigation's unstable_rethrow (node_modules/next/dist/client/components/
// unstable-rethrow.server.js) on the digests those errors carry, rather than
// importing it: that module pulls in client React, which the integration tier's
// react-server condition cannot load.
import { captureException } from "./sentry";

const CONTROL_FLOW_DIGEST =
  /^(?:NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|HANGING_PROMISE_REJECTION|NEXT_PRERENDER_INTERRUPTED)/;

export function isNextControlFlow(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { digest?: unknown; $$typeof?: unknown; cause?: unknown };
  if (typeof e.digest === "string" && CONTROL_FLOW_DIGEST.test(e.digest)) return true;
  // React.postpone (dynamic rendering under PPR) is not an Error at all.
  if (e.$$typeof === Symbol.for("react.postpone")) return true;
  return err instanceof Error && "cause" in err ? isNextControlFlow(err.cause) : false;
}

export async function capturingEscapes<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isNextControlFlow(err)) captureException(err);
    throw err;
  }
}
