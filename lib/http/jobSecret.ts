// THE AUTHENTICATION BOUNDARY FOR /api/jobs/tick, which is the one route in the
// app with no user session behind it.
//
// It cannot have one. A tick is fired by a function that is about to be killed, or
// by a cron — neither holds a cookie, and neither can be given one without
// inventing a service account that could then do everything a user can. So the
// credential is a shared secret instead, and the route's authority is deliberately
// tiny: a valid tick says "advance THIS job one slice", nothing else. Whose job it
// is, and therefore what it may touch, comes from the row (store.resolveJobOwner),
// not from the caller.
//
// TWO FORMS, because the two callers know different things:
//
//   per-job   POST /api/jobs/tick with `x-job-signature: HMAC(secret, jobId)`.
//             Signing the id rather than passing a bearer token means a leaked
//             signature is good for exactly one job.
//   sweep     GET /api/jobs/tick with `authorization: Bearer <secret>` — the cron
//             backstop, which has no job id to sign because finding the stalled
//             ones is its whole purpose.
//
// WHERE THE SECRET COMES FROM. JOBS_SECRET if set. Otherwise it is derived from
// DATABASE_URL, which is a secret that already exists on every instance that could
// possibly serve a tick. That keeps the feature zero-config in development and on a
// fresh deploy, instead of the alternative — a missing env var that silently stops
// every long job from ever finishing its second slice. Rotating the database URL
// invalidates in-flight signatures, which costs one janitor sweep to recover.
import { createHmac, timingSafeEqual } from "node:crypto";

let cached: string | undefined;

function secret(): string {
  if (cached) return cached;
  const explicit = process.env.JOBS_SECRET?.trim();
  if (explicit) return (cached = explicit);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Cannot sign job ticks: set JOBS_SECRET, or DATABASE_URL to derive one from.",
    );
  }
  return (cached = createHmac("sha256", "rag-jobs").update(url).digest("hex"));
}

export function signJobTick(jobId: string): string {
  return createHmac("sha256", secret()).update(jobId).digest("hex");
}

// Constant-time, and length-checked first because timingSafeEqual throws on a
// length mismatch rather than returning false.
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyJobTick(jobId: string, signature: string | null): boolean {
  if (!signature) return false;
  return sameSecret(signJobTick(jobId), signature);
}

// CRON_SECRET is accepted alongside our own because it is what Vercel's scheduler
// actually sends: it attaches `Authorization: Bearer $CRON_SECRET` to a cron
// request and nothing else. Requiring JOBS_SECRET there would mean the backstop
// silently never authenticated — the failure nobody notices, because it only
// matters on the days something else already broke.
export function verifySweepBearer(header: string | null): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  const cron = process.env.CRON_SECRET?.trim();
  return sameSecret(secret(), presented) || (Boolean(cron) && sameSecret(cron!, presented));
}

export const JOB_SIGNATURE_HEADER = "x-job-signature";

// The gate itself, named so scripts/guards.ts can see it in a handler body the
// same way it sees withRequestUser. `fn` runs only for a caller that proved it
// holds the secret.
export async function withJobSecret(
  request: Request,
  jobId: string | null,
  fn: () => Promise<Response>,
): Promise<Response> {
  const ok = jobId
    ? verifyJobTick(jobId, request.headers.get(JOB_SIGNATURE_HEADER))
    : verifySweepBearer(request.headers.get("authorization"));
  if (!ok) return Response.json({ error: "Unauthorized." }, { status: 401 });
  return fn();
}

// Fire a tick at ourselves. Awaited only for the ACK — the receiving handler
// schedules the slice with after() and answers immediately — so the caller learns
// the request landed without waiting out the next slice. Nothing here retries: a
// tick that fails to land leaves the job stalled, which is precisely the state the
// janitor exists to notice.
export async function postJobTick(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${jobsBaseUrl()}/api/jobs/tick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [JOB_SIGNATURE_HEADER]: signJobTick(jobId),
      },
      body: JSON.stringify({ jobId }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[jobs] tick for ${jobId} failed to send: ${String(e)}`);
    return false;
  }
}

// A slice has to address the deployment it is running in, and there is no request
// object at hand when the chain fires. VERCEL_URL is per-deployment, which is what
// we want: a chain should stay inside the deployment that started it rather than
// hop to whatever production is by the time slice 9 runs.
export function jobsBaseUrl(): string {
  const explicit = process.env.JOBS_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) return site.replace(/\/$/, "");
  return `http://localhost:${process.env.PORT ?? 3002}`;
}
