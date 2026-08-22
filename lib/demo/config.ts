// GUEST DEMO SETTINGS — the caps, the TTL, and the four env vars the feature
// cannot run without (docs/guest-demo-plan.md).
//
// SEPARATE FROM lib/config.ts on purpose. That file is the RAG workbench's dials
// — chunk sizes, thresholds, model names — and holds "no API keys here, and no
// env var to read one from" as an explicit rule, because under strict BYOK every
// credential belongs to a user. The demo is the one deliberate exception to that
// rule (it spends the operator's Voyage key on a visitor's behalf), and an
// exception should be visible in its own file rather than smuggled into the one
// whose header promises the opposite.
//
// OFF UNLESS FULLY CONFIGURED. demoEnabled() requires all four secrets, so a
// deployment that has not opted in serves a 404 from /demo rather than a
// half-provisioned guest — and a fifth env var later cannot silently default
// itself into a working demo.
import "server-only";

// The account whose workspace every guest is cloned from. An ordinary user,
// edited through the ordinary UI: re-seeding the demo is "log in as the seed
// account and change something", and every guest minted afterwards inherits it.
export function seedUserId(): string | null {
  return process.env.DEMO_SEED_USER_ID?.trim() || null;
}

// The operator's Voyage key, sealed per guest through the ordinary envelope path
// so that NOTHING else in the app learns that guests exist (lib/demo/provision).
//
// It is a public spending endpoint by construction. Cap it at Voyage — spend
// limit and rate limit — and rotate it by changing this one variable.
export function demoVoyageKey(): string | null {
  return process.env.DEMO_VOYAGE_KEY?.trim() || null;
}

// Salt for the per-IP hash in demo_provisions (0075). Its own variable rather
// than a reuse of some other secret: rotating it resets every rate-limit
// counter, which is an operator action worth being able to take on its own.
export function ipSalt(): string | null {
  return process.env.DEMO_IP_SALT?.trim() || null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const demo = {
  // How long a guest workspace lives. Two hours is long enough that nobody is
  // hurried through the demo and short enough that ~40 concurrent guests is a
  // ceiling nothing realistic reaches (the plan's storage arithmetic).
  get ttlMinutes() {
    return intEnv("DEMO_TTL_MINUTES", 120);
  },

  // THE STORAGE CAP, in guests. ~8.3 MB each against ~340 MB of headroom on the
  // free tier is ~40; this sits below that so the wall is a friendly panel
  // rather than a write failure somewhere deep in the clone.
  //
  // It binds later than the CONNECTION ceiling does — lib/db.ts pins one pooled
  // connection per scope against the database's 60 — so in practice concurrency
  // fails first, and gracefully, by queueing.
  get maxLiveGuests() {
    return intEnv("DEMO_MAX_GUESTS", 25);
  },

  // Per-address provisioning limit, over the window below. This is what stops
  // one visitor minting 500 workspaces, and it is also what protects the 50,000
  // MAU allowance: every guest burns one, and deleting the account does not give
  // it back.
  get perIpPerWindow() {
    return intEnv("DEMO_PER_IP_PER_WINDOW", 3);
  },
  get ipWindowMinutes() {
    return intEnv("DEMO_IP_WINDOW_MINUTES", 24 * 60);
  },

  // Embedding tokens one guest may spend before the demo says so. Every question
  // a guest asks embeds once (~20 tokens) plus whatever a cache miss costs, so
  // this is generous for a demo and small against a real bill. Enforced in
  // lib/demo/budget.ts off the provider_key_usage ledger (0072).
  get embedTokenBudget() {
    return intEnv("DEMO_EMBED_TOKEN_BUDGET", 200_000);
  },
} as const;

// Is the demo configured at all? Every entry point asks this first.
//
// SUPABASE_SECRET_KEY is in the list because provisioning needs the Admin API to
// create a confirmed user without sending mail — see lib/demo/admin.ts for why
// that credential is introduced here and nowhere else.
export function demoEnabled(): boolean {
  return Boolean(
    seedUserId() &&
      demoVoyageKey() &&
      ipSalt() &&
      (process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
  );
}

// Why the demo is off, for an operator reading a log. Never shown to a visitor:
// a misconfigured demo looks like no demo from outside.
export function demoDisabledReason(): string | null {
  if (!seedUserId()) return "DEMO_SEED_USER_ID is not set";
  if (!demoVoyageKey()) return "DEMO_VOYAGE_KEY is not set";
  if (!ipSalt()) return "DEMO_IP_SALT is not set";
  if (!demoEnabled()) return "SUPABASE_SECRET_KEY is not set";
  return null;
}
