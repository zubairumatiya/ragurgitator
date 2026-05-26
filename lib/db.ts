// ---------------------------------------------------------------------------
// Shared Postgres client.
//
// We connect through Supabase's transaction pooler, which means prepared
// statements aren't supported — `prepare: false` is required or the postgres
// client will throw "prepared statement does not exist" once the pooler
// recycles its backend session.
//
// In dev, Next.js re-imports modules on every hot-reload; the globalThis
// cache keeps us from opening a brand-new connection pool each time.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local.");
}

declare global {
  // eslint-disable-next-line no-var
  var __ragSql: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__ragSql ??
  postgres(url, {
    prepare: false,
    ssl: "require",
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__ragSql = sql;
}
