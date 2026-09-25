// A KNOWN TRAFFIC SHAPE — docs/obs-4-ci-budgets-plan.md §1.4.
//
//   npm run obs:replay -- --url https://<preview>.vercel.app --laps 3
//   npm run obs:replay -- --url http://localhost:3002 --laps 3 --address 10.1.2.3
//
// Mints ONE guest, then replays the demo walk's request sequence N times with a
// fixed think time between requests, and prints per-route p50/p95 and status
// counts. It exists so that what O1 (errors), O2 (logs) and O5 (spans) emit can
// be read under a load whose shape is already known: the same five requests the
// Eval tab makes when a visitor walks it (scripts/demo-walk.ts), ending each lap
// with Start over so every lap begins from the same empty board.
//
// BOUNDED ON PURPOSE. One guest, not one per lap: the per-address provisioning
// cap (three per 24 h, lib/demo/rateLimit.ts) refuses a burst, and a refusal is
// the cap working, not a defect — the script says which cap answered and stops.
// `--laps` defaults to 3 so a run against a preview costs nothing beyond the
// walk's query embeds (the presses replay the banked tuning shelf).
//
// Statuses are COUNTED, never thrown on: a 500 in lap 2 is exactly the kind of
// thing this run is meant to produce evidence of, so the lap finishes and the
// table shows it. Only a failed mint ends the run, because nothing can follow it.
//
// `--address` sets x-forwarded-for, which only a dev server honours (Vercel and
// Cloudflare overwrite it); it is how a local run avoids sharing the "unknown"
// bucket with every other local mint of the day.

const args = process.argv.slice(2);
const valueOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};

const BASE = valueOf("--url", "http://localhost:3002").replace(/\/$/, "");
const LAPS = Math.max(1, Number(valueOf("--laps", "3")) || 3);
const THINK_MS = Math.max(0, Number(valueOf("--think", "1500")) || 0);
const ADDRESS = valueOf("--address", "");

type Guest = { cookie: string; configId: string };
type Sample = { route: string; ms: number; status: string };
const samples: Sample[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mintGuest(): Promise<Guest> {
  const headers: Record<string, string> = {};
  if (ADDRESS) headers["x-forwarded-for"] = ADDRESS;
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/demo/start`, { method: "POST", headers });
  samples.push({ route: "POST /api/demo/start", ms: performance.now() - t0, status: String(res.status) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const why =
      res.status === 429
        ? "the per-address provisioning cap refused this run (three guests per address per 24 h)"
        : res.status === 503
          ? "the live-guest ceiling refused this run (twenty at once)"
          : res.status === 404
            ? "this deployment has no demo configured"
            : "provisioning failed";
    console.error(`\ndemo/start answered ${res.status} — ${why}: ${body}\n`);
    process.exit(2);
  }
  const body = (await res.json()) as { redirect: string };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.error("demo/start set no cookie; nothing can follow the mint");
    process.exit(2);
  }
  return { cookie, configId: body.redirect.replace(/^\/c\//, "") };
}

// A streamed route answers 200 and then may say "error" in its last NDJSON line;
// that is recorded as its own status so the table separates a transport failure
// from a producer that gave up.
async function post(guest: Guest, path: string, body: unknown): Promise<void> {
  const route = `POST ${path}`;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}?configId=${guest.configId}`, {
      method: "POST",
      headers: { cookie: guest.cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let status = String(res.status);
    if (res.ok && res.headers.get("content-type")?.includes("ndjson")) {
      const lines = text.split("\n").filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (last) {
        try {
          if ((JSON.parse(last) as { type?: string }).type === "error") status = "200+stream-error";
        } catch {
          status = "200+bad-ndjson";
        }
      }
    }
    samples.push({ route, ms: performance.now() - t0, status });
  } catch (err) {
    samples.push({ route, ms: performance.now() - t0, status: `fetch-failed:${(err as Error).name}` });
  }
}

async function get(guest: Guest, path: string): Promise<void> {
  const route = `GET ${path}`;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}?configId=${guest.configId}`, { headers: { cookie: guest.cookie } });
    await res.text();
    samples.push({ route, ms: performance.now() - t0, status: String(res.status) });
  } catch (err) {
    samples.push({ route, ms: performance.now() - t0, status: `fetch-failed:${(err as Error).name}` });
  }
}

// One lap = the Eval tab walk: list documents, Add cached, Score pending, Auto
// tune, Start over. The order matters (Score pending needs an unscored board,
// the press needs a scored one) and Start over is what makes lap 2 the same
// shape as lap 1.
async function lap(guest: Guest, n: number): Promise<void> {
  const steps: Array<() => Promise<void>> = [
    () => get(guest, "/api/documents"),
    () => post(guest, "/api/eval/bulk-generate", { cachedOnly: true }),
    () => post(guest, "/api/eval/process", {}),
    () => post(guest, "/api/eval/autotune", {}),
    () => post(guest, "/api/demo/restart", {}),
  ];
  const t0 = performance.now();
  for (const step of steps) {
    await step();
    await sleep(THINK_MS);
  }
  const s = samples.slice(-steps.length);
  console.log(
    `lap ${n}/${LAPS}: ${((performance.now() - t0) / 1000).toFixed(1)} s · ` +
      s.map((x) => `${x.route.split(" ")[1]!.replace("/api/", "")} ${x.status} ${(x.ms / 1000).toFixed(1)}s`).join(" · "),
  );
}

// Nearest-rank, rounding UP: with three laps p95 is the slowest lap, not the median.
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * p))] ?? 0;

function report(): void {
  const byRoute = new Map<string, Sample[]>();
  for (const s of samples) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);
  const rows = [...byRoute.entries()].map(([route, list]) => {
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const statuses = new Map<string, number>();
    for (const s of list) statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
    return {
      route,
      n: list.length,
      p50: `${(pct(sorted, 0.5) / 1000).toFixed(2)} s`,
      p95: `${(pct(sorted, 0.95) / 1000).toFixed(2)} s`,
      statuses: [...statuses.entries()].map(([k, v]) => `${k}×${v}`).join(" "),
    };
  });
  console.log("");
  console.table(rows);
  const bad = samples.filter((s) => s.status !== "200").length;
  console.log(bad === 0 ? "every request answered 200" : `${bad} request(s) did not answer a clean 200 — see the statuses column`);
}

async function main() {
  console.log(`replaying ${LAPS} lap(s) against ${BASE} with ${THINK_MS} ms think time\n`);
  const guest = await mintGuest();
  console.log(`guest ${guest.configId}\n`);
  for (let n = 1; n <= LAPS; n++) await lap(guest, n);
  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
