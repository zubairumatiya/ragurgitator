// Where the integration tier's database URLs come from, and the check that they
// point somewhere throwaway.
//
// This lives apart from harness.ts for one reason: `test/support/env.ts` runs as
// a `--import` preload, before the test runner exists, and harness.ts pulls in
// `node:test` at module scope. The safety check has to be reachable without
// dragging the runner in with it.
import { sslFor } from "../../lib/dbSsl";

// 0051 creates the `rag_app` role without a password on purpose (a migration is
// committed, a password is not), so the harness sets one — see ensureAppRole.
export const APP_ROLE_PASSWORD = "rag_app_test";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start a throwaway database with " +
        "`npm run itest:up`, which prints the URL to export.",
    );
  }
  assertLocal(url);
  return url;
}

// The whole safety story. `sslFor` already decides TLS from the hostname, so
// reusing it here means one definition of "local" rather than two that can drift.
export function assertLocal(url: string) {
  if (sslFor(url) !== false) {
    throw new Error(
      `Refusing to run integration tests against a non-local database: ${redact(url)}. ` +
        "This tier truncates tables and deletes users.",
    );
  }
}

export function redact(url: string): string {
  try {
    const u = new URL(url);
    u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

// The `rag_app` connection, derived from the admin one.
export function appDatabaseUrl(): string {
  const u = new URL(testDatabaseUrl());
  u.username = "rag_app";
  u.password = APP_ROLE_PASSWORD;
  return u.toString();
}
