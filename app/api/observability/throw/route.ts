// API route: GET /api/observability/throw — throw on purpose, so a deploy can prove
// its errors reach Sentry (docs/obs-1-sentry-plan.md Phase 4, docs/obs-4-ci-budgets-plan.md
// preview round trip).
//
// Gated by the job secret like /api/jobs/tick: the caller is a CI step or a person
// with the secret, never a browser session, and an unauthenticated visitor must not
// be able to fill the error quota. It answers 401 without the bearer, and never
// returns 200 with it — the throw escaping the handler is the point, because that is
// the path Next's onRequestError (instrumentation.ts) covers, and a capture by hand
// here would prove nothing about the seam we actually rely on. The two seams Next
// cannot see (the NDJSON producer, the detached queue) are covered by the unit test
// in lib/observability/sentry.test.ts instead; they need a user scope this route
// deliberately does not open.
import { withJobSecret } from "@/lib/http/jobSecret";
import { setRequestTags } from "@/lib/observability/sentry";

export class ObservabilityProbeError extends Error {
  constructor() {
    super("Sentry verification throw from /api/observability/throw");
    this.name = "ObservabilityProbeError";
  }
}

export async function GET(request: Request) {
  return withJobSecret(request, null, async () => {
    setRequestTags({ route: "observability/throw" });
    throw new ObservabilityProbeError();
  });
}
