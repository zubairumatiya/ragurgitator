// END-TO-END TESTS against a RUNNING deployment — never a server this config
// starts. A browser test that signs in needs Supabase Auth, Key Vault and the
// seed account's banks, which only a real deployment has; the Vercel preview is
// the one CI drives (.github/workflows/e2e.yml), and a laptop points E2E_BASE_URL
// at `npm run dev` or at any URL. See docs/ui-tests-plan.md §2.
import { defineConfig, devices } from "@playwright/test";

const baseURL = (process.env.E2E_BASE_URL ?? "http://localhost:3002").replace(/\/$/, "");

// Preview deployments sit behind Vercel Authentication. The bypass header gets
// the FIRST request through; `x-vercel-set-bypass-cookie` makes Vercel answer it
// with a cookie so every navigation the browser makes on its own (a redirect,
// a router.refresh, a <Link>) is also let through. Without the second header
// only the requests Playwright itself issues would carry the secret. Unset
// locally and against production, where there is no wall.
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

// LOCAL ONLY. The demo caps provisioning at three per address per day
// (lib/demo/rateLimit.ts), and a laptop iterating on demo.spec.ts against
// `npm run dev` would spend them in one afternoon. Against a dev server the
// forwarded-for header is whatever the client says it is, so, exactly as
// scripts/demo-walk.ts does, a random private address per run keeps the cap
// out of the loop. Never set in CI: there the cap is part of what is under
// test, and Vercel overwrites the header anyway.
const spoof = process.env.E2E_SPOOF_ADDRESS
  ? { "x-forwarded-for": `10.${rnd()}.${rnd()}.${rnd(1)}` }
  : undefined;
function rnd(min = 0): number {
  return min + Math.floor(Math.random() * (255 - min));
}

const extraHTTPHeaders =
  bypass || spoof
    ? {
        ...(bypass
          ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" }
          : {}),
        ...spoof,
      }
    : undefined;

export default defineConfig({
  testDir: "e2e",
  // The demo spec mints ONE guest and walks it in order; the auth spec is
  // independent. Files run in parallel, tests within a file in sequence.
  fullyParallel: false,
  workers: 2,
  // A flaky e2e is information, not noise, but a single retry keeps a transient
  // cold start from failing a deploy's verdict.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // The eval walk streams: Add ~ seconds, Score pending ~ 6 s on the bank, and a
  // cold Lambda adds more. Per-test budget, not per-assertion.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    extraHTTPHeaders,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
