// LIGHTHOUSE AGAINST A RUNNING DEPLOYMENT — the synthetic half of O3
// (docs/obs-3-web-vitals-plan.md). Three pages: the demo front door `/demo`,
// the login wall, and a guest's eval page. (Not `/`: a stranger is redirected
// from it to /login, so it would measure the wall twice.) The first two are measured with no session;
// the third needs one, so ONE guest is minted through the same front-door click
// the e2e spec uses (e2e/support/demo.ts), and its cookies are replayed as a
// header on every Lighthouse request for that page. One guest per run, not
// three: the per-address cap counts each mint.
//
// Each page runs RUNS times and the median-performance run is the one reported,
// because a single run on a shared runner swings by more than any margin a
// budget could hold. Prints a score table; if lighthouse-budgets.json exists,
// exits 1 on any page over budget. Reports land in lighthouse-report/, which CI
// uploads — so the headers (bypass secret, guest session) are kept out of it:
// the headers file lives in the temp dir and each report's copy of its settings
// is scrubbed before it is written back.
//
//   E2E_BASE_URL=https://… VERCEL_AUTOMATION_BYPASS_SECRET=… npm run lighthouse
//   E2E_BASE_URL=http://localhost:3002 E2E_SPOOF_ADDRESS=1 npm run lighthouse
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";

import { startDemoFromFrontDoor } from "../e2e/support/demo";

const LIGHTHOUSE = "lighthouse@13.5.0";
const RUNS = Number(process.env.LH_RUNS ?? 3);
const OUT = "lighthouse-report";
const BUDGETS = "lighthouse-budgets.json";

const baseURL = (process.env.E2E_BASE_URL ?? "http://localhost:3002").replace(
  /\/$/,
  "",
);
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

type Measured = {
  page: string;
  performance: number;
  accessibility: number;
  totalByteWeight: number;
  scriptCount: number;
};

type Budget = {
  performance: number;
  accessibility: number;
  totalByteWeight: number;
  scriptCount: number;
};

// Same spoof as playwright.config.ts: local runs only, so a dev loop does not
// spend the per-address cap. Vercel overwrites the header anyway.
function spoofHeader(): Record<string, string> {
  if (!process.env.E2E_SPOOF_ADDRESS) return {};
  const r = (min = 0) => min + Math.floor(Math.random() * (255 - min));
  return { "x-forwarded-for": `10.${r()}.${r()}.${r(1)}` };
}

const bypassHeaders: Record<string, string> = bypass
  ? { "x-vercel-protection-bypass": bypass }
  : {};

async function mintGuest(): Promise<{ configId: string; cookie: string }> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: {
        ...(bypass
          ? { ...bypassHeaders, "x-vercel-set-bypass-cookie": "true" }
          : {}),
        ...spoofHeader(),
      },
    });
    const page = await context.newPage();
    const configId = await startDemoFromFrontDoor(page);
    // Only the app's own cookies: the bypass cookie is replaced by the header.
    const host = new URL(baseURL).hostname;
    const cookies = (await context.cookies()).filter(
      (c) =>
        c.domain.replace(/^\./, "") === host && !c.name.startsWith("_vercel"),
    );
    return {
      configId,
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    };
  } finally {
    await browser.close();
  }
}

function runLighthouse(
  name: string,
  url: string,
  headers: Record<string, string>,
): Measured {
  const runs: Measured[] = [];
  const headersFile = path.join(
    tmpdir(),
    `lighthouse-headers-${process.pid}-${name}.json`,
  );
  writeFileSync(headersFile, JSON.stringify(headers));
  try {
    for (let i = 0; i < RUNS; i++)
      runs.push(runOnce(name, url, headersFile, i));
  } finally {
    rmSync(headersFile, { force: true });
  }
  runs.sort((a, b) => a.performance - b.performance);
  return runs[Math.floor(runs.length / 2)];
}

function runOnce(
  name: string,
  url: string,
  headersFile: string,
  i: number,
): Measured {
  const out = path.join(OUT, `${name}-${i}.report.json`);
  execFileSync(
    "npx",
    [
      "--yes",
      LIGHTHOUSE,
      url,
      "--preset=desktop",
      "--only-categories=performance,accessibility",
      "--output=json",
      `--output-path=${out}`,
      `--extra-headers=${headersFile}`,
      "--chrome-flags=--headless=new --no-sandbox",
      "--quiet",
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CHROME_PATH: chromium.executablePath() },
    },
  );
  const lhr = JSON.parse(readFileSync(out, "utf8"));
  delete lhr.configSettings.extraHeaders;
  writeFileSync(out, JSON.stringify(lhr));
  if (lhr.runtimeError)
    throw new Error(
      `${name}: ${lhr.runtimeError.code} ${lhr.runtimeError.message}`,
    );
  // A redirect off the page under test (an expired session bouncing to
  // /login, say) would measure the wrong page and read as a pass.
  if (new URL(lhr.finalDisplayedUrl).pathname !== new URL(url).pathname) {
    throw new Error(
      `${name}: asked for ${url}, Lighthouse ended on ${lhr.finalDisplayedUrl}`,
    );
  }
  const scripts = lhr.audits["resource-summary"].details.items.find(
    (it: { resourceType: string }) => it.resourceType === "script",
  );
  return {
    page: name,
    performance: lhr.categories.performance.score,
    accessibility: lhr.categories.accessibility.score,
    totalByteWeight: lhr.audits["total-byte-weight"].numericValue,
    scriptCount: scripts?.requestCount ?? 0,
  };
}

function check(m: Measured, b: Budget | undefined): string[] {
  if (!b) return [];
  const over: string[] = [];
  if (m.performance < b.performance)
    over.push(`performance ${m.performance} < ${b.performance}`);
  if (m.accessibility < b.accessibility)
    over.push(`accessibility ${m.accessibility} < ${b.accessibility}`);
  if (m.totalByteWeight > b.totalByteWeight)
    over.push(`bytes ${Math.round(m.totalByteWeight)} > ${b.totalByteWeight}`);
  if (m.scriptCount > b.scriptCount)
    over.push(`scripts ${m.scriptCount} > ${b.scriptCount}`);
  return over;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const publicHeaders = { ...bypassHeaders, ...spoofHeader() };

  const measured: Measured[] = [];
  measured.push(runLighthouse("demo", `${baseURL}/demo`, publicHeaders));
  measured.push(runLighthouse("login", `${baseURL}/login`, publicHeaders));

  const guest = await mintGuest();
  measured.push(
    runLighthouse("guest-eval", `${baseURL}/c/${guest.configId}/eval`, {
      ...publicHeaders,
      Cookie: guest.cookie,
    }),
  );

  const budgets: Record<string, Budget> | undefined = existsSync(BUDGETS)
    ? JSON.parse(readFileSync(BUDGETS, "utf8")).pages
    : undefined;

  console.log(
    `\nLighthouse (desktop, median of ${RUNS} by performance) — ${baseURL}`,
  );
  console.log("page        perf  a11y  bytes      scripts  verdict");
  let failed = false;
  for (const m of measured) {
    const over = check(m, budgets?.[m.page]);
    if (over.length) failed = true;
    const verdict = !budgets
      ? "no budget"
      : over.length
        ? `OVER: ${over.join(", ")}`
        : "ok";
    console.log(
      `${m.page.padEnd(11)} ${m.performance.toFixed(2)}  ${m.accessibility.toFixed(2)}  ${String(Math.round(m.totalByteWeight)).padEnd(9)}  ${String(m.scriptCount).padEnd(7)}  ${verdict}`,
    );
  }
  writeFileSync(
    path.join(OUT, "summary.json"),
    JSON.stringify(measured, null, 2),
  );
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
