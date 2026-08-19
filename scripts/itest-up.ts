// Builds a throwaway integration database on a laptop: container, schema, role.
//
// CI does the same three things with a service container instead (see
// .github/workflows/ci.yml), so this is the local convenience, not the
// definition. Both end up at the same place: a database replayed from
// migrations/ with `rag_app` able to log in.
//
// Destroys and recreates the container every run. That is the point — a
// throwaway database whose state carries over between runs is just a slow local
// database with a confusing name.
//
//   npm run itest:up      then export the two URLs it prints
//   npm run itest:down    when finished
import { execFileSync } from "node:child_process";

const CONTAINER = "rag-itest";
const PORT = process.env.ITEST_PORT ?? "55432";
const IMAGE = "pgvector/pgvector:pg17";
const DB = "rag_test";
const URL = `postgres://postgres:postgres@localhost:${PORT}/${DB}`;

const run = (cmd: string, args: string[], opts: { quiet?: boolean } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit" });

function docker(args: string[], quiet = true) {
  try {
    return run("docker", args, { quiet });
  } catch (error) {
    if (quiet) return "";
    throw error;
  }
}

console.log(`recreating ${CONTAINER} on port ${PORT}…`);
docker(["rm", "-f", CONTAINER]);
run("docker", [
  "run", "-d", "--name", CONTAINER,
  "-e", "POSTGRES_PASSWORD=postgres",
  "-e", `POSTGRES_DB=${DB}`,
  "-p", `${PORT}:5432`,
  IMAGE,
], { quiet: true });

// pg_isready rather than a fixed sleep: the image runs an internal restart
// during first-time initdb, so a container that answers once may still go away.
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"]);
    run("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", DB, "-tAc", "select 1"], { quiet: true });
    ready = true;
    break;
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}
if (!ready) {
  console.error(`${CONTAINER} never became ready. \`docker logs ${CONTAINER}\` has the reason.`);
  process.exit(1);
}

console.log("replaying migrations…");
execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
  encoding: "utf8",
  stdio: "inherit",
  // The auth shim goes on before 0001: a bare container has no auth.users, and
  // four migrations reach for it.
  env: { ...process.env, DATABASE_URL: URL, MIGRATE_BOOTSTRAP: "test/sql" },
});

console.log("\nready. Export these, then `npm run itest`:\n");
console.log(`  export TEST_DATABASE_URL=${URL}`);
