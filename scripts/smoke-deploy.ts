// PROVES EVERY ROUTE'S MODULE TREE ACTUALLY LOADS ON THE DEPLOYED HOST.
//
// This is the probe that found the bug in docs/serverless-bundle-fix-plan.md,
// turned into a check that runs on its own. Six routes had been returning 500 in
// production since the first deploy — background jobs had never once worked —
// because a route's module tree is only assembled when a request reaches it, and
// nothing in CI ever makes a request to a real Lambda. A build that succeeds and
// a bundle that runs are different claims.
//
// IT ASSERTS THE SPECIFIC REJECTION, NOT "not a 500". A route that answers 401 is
// telling us two things at once: the module tree loaded, and the authentication
// boundary is live. Accepting any non-500 would pass a deployment whose auth had
// been disarmed, which is a worse outcome than the crash this exists to catch.
//
//   Usage: npm run smoke -- https://my-preview.vercel.app
//          SMOKE_BASE_URL=… npm run smoke
//
// Preview deployments sit behind Vercel Authentication, so every request carries
// x-vercel-protection-bypass. Without the secret the whole run would report 401s
// from Vercel's own gate rather than from the app, which would look like a pass
// — so a missing secret against a protected deployment is a hard failure, not a
// skip.

type Probe = {
  path: string;
  method: string;
  expect: number[];
  proves: string;
  headers?: Record<string, string>;
  body?: string;
};

// A signature that is well-formed but wrong: it has to get past the "is a
// signature present" check to exercise the comparison itself.
const BOGUS_SIGNATURE = "0".repeat(64);

const PROBES: Probe[] = [
  // The six that were dead. Each one's module tree reaches lib/rag/chunker.ts.
  {
    path: "/api/jobs",
    method: "GET",
    expect: [401],
    proves: "module tree loads, auth boundary live",
  },
  {
    path: "/api/jobs/tick",
    method: "GET",
    expect: [401],
    proves: "the sweep path, incl. jobSecret",
    headers: { authorization: "Bearer not-the-jobs-secret" },
  },
  {
    path: "/api/jobs/tick",
    method: "POST",
    expect: [401],
    proves: "the chained-tick path, incl. the HMAC comparison",
    headers: { "content-type": "application/json", "x-job-signature": BOGUS_SIGNATURE },
    // A jobId is required BEFORE the signature is checked, so without one this
    // probe would 400 and never reach the boundary it is here to exercise.
    body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
  },
  {
    path: "/api/jobs/poll",
    method: "POST",
    expect: [401],
    proves: "the janitor sweep path",
  },
  {
    // POST-only, and it parses the form BEFORE authenticating — so an empty body
    // is rejected at 400 by handler code that has demonstrably run. That is the
    // claim being made here; the auth boundary on this route is guards.ts sweep 3.
    path: "/api/ingest",
    method: "POST",
    expect: [400],
    proves: "the ingest tree — the heaviest transformers-adjacent graph",
  },
  { path: "/api/eval", method: "GET", expect: [401], proves: "the eval tree" },
  { path: "/api/batch", method: "GET", expect: [401], proves: "the batch tree" },

  // Controls. These were healthy throughout, so a failure here says the problem
  // is the deployment or the probe, not the bundle fix.
  { path: "/api/configs", method: "GET", expect: [401], proves: "control — healthy throughout" },
  { path: "/api/documents", method: "GET", expect: [401], proves: "control — healthy throughout" },
  { path: "/login", method: "GET", expect: [200], proves: "control — the app renders" },
];

function baseUrl(): string {
  const raw = process.argv[2] ?? process.env.SMOKE_BASE_URL;
  if (!raw) {
    console.error("Usage: npm run smoke -- <base-url>   (or set SMOKE_BASE_URL)");
    process.exit(2);
  }
  return raw.replace(/\/$/, "");
}

function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

async function run() {
  const base = baseUrl();
  const bypass = bypassHeaders();
  console.log(`Smoke test against ${base}`);
  console.log(
    Object.keys(bypass).length > 0
      ? "Sending the Vercel protection bypass header.\n"
      : "No VERCEL_AUTOMATION_BYPASS_SECRET set — fine for production, fatal for a protected preview.\n",
  );

  let failures = 0;
  for (const probe of PROBES) {
    const url = `${base}${probe.path}`;
    let status: number;
    let detail = "";
    try {
      const res = await fetch(url, {
        method: probe.method,
        headers: { ...bypass, ...probe.headers },
        body: probe.body,
        // Never follow a redirect: /login is a 200 and every /api route answers
        // in place, so a 3xx is itself a finding.
        redirect: "manual",
      });
      status = res.status;
      if (!probe.expect.includes(status)) {
        detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      }
    } catch (err) {
      status = 0;
      detail = String(err);
    }

    const ok = probe.expect.includes(status);
    if (!ok) failures++;
    const label = `${probe.method} ${probe.path}`.padEnd(28);
    const got = String(status).padEnd(4);
    console.log(
      ok
        ? `  ✓ ${label} ${got} ${probe.proves}`
        : `  ✗ ${label} ${got} expected ${probe.expect.join("/")} — ${detail}`,
    );
  }

  console.log(
    failures === 0
      ? `\nOK — ${PROBES.length} probes, every route answered with its own rejection.`
      : `\nFAILED — ${failures} of ${PROBES.length} probes.`,
  );
  if (failures) process.exitCode = 1;
}

run();
