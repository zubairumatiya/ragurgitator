// Points lib/db.ts at the throwaway database, before lib/db.ts can be imported.
//
// WHY THIS EXISTS AS A PRELOAD, NOT AN IMPORT
//
// Tests 1–3 only ever use the harness's own clients, so TEST_DATABASE_URL is the
// only thing they read. Tests 4+ are different: they exercise the app's real
// machinery — withUserTransaction, isolated, runOutsideUserTransaction,
// toJsonb, probeSemanticCache — so they import lib/db.ts, directly or through
// something else. That module reads DATABASE_URL and RAG_APP_DATABASE_URL at
// MODULE SCOPE and builds its pools there.
//
// So the danger is real and quiet: run the tier the way every other script in
// this repo is run (`--env-file=.env.local`) and lib/db.ts connects to the live
// project, where the tests then open withUser scopes, savepoints, and
// truncations against real data. harness.ts's assertLocal does not help —
// lib/db.ts never consults it, and by the time a test body runs the pool is
// already built.
//
// Import order is the entire mechanism. This file must be loaded with
// `node --import ./test/support/env.ts`; a top-level import inside a test file
// is already too late. `npm run itest` passes the flag, so the tier cannot be
// run without it.
import { appDatabaseUrl, assertLocal, redact, testDatabaseUrl } from "./dbUrls";

// A pre-existing value is not "already configured", it is the failure we are
// here to catch: .env.local was loaded, or a shell has production exported.
// Refuse rather than overwrite, unless it already points at the same throwaway
// database. A local value is allowed through and simply replaced by the derived
// one: it cannot destroy anything that matters.
function claim(name: string, derived: string) {
  const existing = process.env[name];
  if (existing && existing !== derived) {
    try {
      assertLocal(existing);
    } catch {
      throw new Error(
        `${name} is already set to a non-local database (${redact(existing)}). ` +
          "The integration tier refuses to start rather than point the app's own " +
          "pools at it. Run `npm run itest` without --env-file=.env.local, and " +
          `unset ${name} in this shell.`,
      );
    }
  }
  process.env[name] = derived;
}

// testDatabaseUrl() runs assertLocal, so everything derived from it is local by
// construction.
claim("DATABASE_URL", testDatabaseUrl());
claim("RAG_APP_DATABASE_URL", appDatabaseUrl());
