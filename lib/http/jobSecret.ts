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
        ...protectionBypass(),
      },
      body: JSON.stringify({ jobId }),
    });
    return res.ok;
  } catch (e) {
    console.warn(`[jobs] tick for ${jobId} failed to send: ${String(e)}`);
    return false;
  }
}

// DEPLOYMENT PROTECTION. The project runs Vercel Authentication with
// deploymentType `all_except_custom_domains`, so a request to a *.vercel.app
// deployment url is answered with a login page rather than the handler — and a
// tick is an ordinary outside request, however much it looks internal. Slice 1
// would run, slice 2 would never land, and the only symptom is a job that stops
// advancing until the janitor sweep notices.
//
// Production sidesteps this by addressing the custom domain (see jobsBaseUrl).
// This header is what carries PREVIEW deployments, which have no exempt domain
// of their own, and it is the fallback if that lookup ever returns nothing.
//
// The secret exists only once "Protection Bypass for Automation" is enabled in
// the project's Deployment Protection settings, which injects
// VERCEL_AUTOMATION_BYPASS_SECRET into the build. Absent — locally, or before
// that switch is thrown — this contributes no header at all rather than an empty
// one, since a blank value is a bypass attempt that fails rather than a request
// that never tried.
function protectionBypass(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

// A slice has to address the app it is running in, and there is no request object
// at hand when the chain fires.
//
// IN PRODUCTION, THE CUSTOM DOMAIN. VERCEL_PROJECT_PRODUCTION_URL is the shortest
// production custom domain (ragurgitator.com), which is the one address exempt
// from this project's Vercel Authentication. The obvious-looking choice, VERCEL_URL,
// is the per-deployment *.vercel.app address, and Vercel's own reference says it
// "cannot be used in conjunction with Standard Deployment Protection" — behind the
// wall, a tick is answered with a login page instead of the handler.
//
// What that gives up: a chain no longer stays inside the deployment that started
// it, so a mid-job deploy moves slice 9 onto the new build. That is the better
// trade here. Slices checkpoint to the database rather than to memory, so the new
// build resumes from the same row, and the deployment being superseded is a worse
// host for the rest of the job than current production is.
//
// EVERYWHERE ELSE, THE DEPLOYMENT. VERCEL_PROJECT_PRODUCTION_URL is set on preview
// deployments too, so using it unconditionally would have a preview's job quietly
// run its remaining slices on production. Preview stays on VERCEL_URL, where the
// bypass header above is what gets it past the wall.
export function jobsBaseUrl(): string {
  const explicit = process.env.JOBS_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) return site.replace(/\/$/, "");
  return `http://localhost:${process.env.PORT ?? 3002}`;
}
