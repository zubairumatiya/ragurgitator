// ---------------------------------------------------------------------------
// Three greppable invariants, each of which has already been violated once, and
// none of which a typecheck, a unit test or a page that renders one account's
// data can see.
//
//   1. .expose() appears only where a provider client is constructed.
//   2. Every app entry point that touches the store enters a request scope.
//   3. Every API handler is behind the authentication boundary — per METHOD.
//
// WHY A SCRIPT AND NOT CI. There is no CI in this repo, and standing up a
// workflow to hold one job is more machinery than the invariants need. Adding it
// later is `npm run guard && npm run lint && npm test` in a workflow file, so
// nothing here has to change when that happens.
//
// WHY GREP AND NOT THE TYPE SYSTEM. All three are properties of where a call
// APPEARS, not of what it returns, so there is no signature that could encode
// them. The mitigation for grep's bluntness is that every sweep asserts an
// allowlist: a new violation fails by name, and a deliberate exception has to be
// added here with a reason next to it.
//
//   Usage: npm run guard   (no database, no network, no env)
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

let failures = 0;
function fail(message: string) {
  failures++;
  console.log(`  ✗ ${message}`);
}

function walk(dir: string, match: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out.sort();
}

const read = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(ROOT, path);

// ---------------------------------------------------------------------------
// 1. The .expose() allowlist
//
// lib/crypto/secretKey.ts wraps a decrypted provider key so it cannot reach a
// log, a JSON response or a stack trace by accident: it overrides toString,
// toJSON and the inspect symbol, and only .expose() yields the real string. The
// wrapper is worth exactly as much as the discipline about where that call
// appears, and nothing but this sweep enforces it.
//
// The rule is "inline at the construction site" — `build(secret.expose())`, not
// `const key = secret.expose()`, because a local variable is a plain string that
// outlives the expression and can be logged, spread or serialised downstream.
// ---------------------------------------------------------------------------
const EXPOSE_ALLOWED: Record<string, string> = {
  "lib/crypto/secretKey.ts": "defines it",
  "lib/llm/client.ts": "inline in build(secret.expose())",
  "lib/batch/providers.ts": "inline in the Bearer header literal",
};

function sweepExpose() {
  console.log("1. .expose() call sites\n");
  const files = walk(join(ROOT, "lib"), (p) => p.endsWith(".ts") || p.endsWith(".tsx"));
  files.push(...walk(join(ROOT, "app"), (p) => p.endsWith(".ts") || p.endsWith(".tsx")));

  for (const file of files) {
    const path = rel(file);
    // Tests and operator scripts are exempt as a category: neither ships to a
    // user, and a round-trip assertion has to compare the plaintext.
    if (path.endsWith(".test.ts")) continue;

    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      // Skip comments — secretKey.ts and providerKeys.ts describe the contract
      // in prose, and the words are not calls.
      const code = line.replace(/\/\/.*$/, "");
      if (!code.includes(".expose()")) return;

      const why = EXPOSE_ALLOWED[path];
      if (!why) {
        fail(`${path}:${i + 1} — .expose() outside the allowlist in scripts/guards.ts`);
        return;
      }
      // Allowed file, but still check the call is not being parked in a local.
      if (/(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*[\w.]*\.expose\(\)/.test(code)) {
        fail(`${path}:${i + 1} — .expose() assigned to a variable; inline it at the call`);
      }
    });
  }

  for (const [path, why] of Object.entries(EXPOSE_ALLOWED)) {
    console.log(`   ${path.padEnd(28)} ${why}`);
  }
}

// ---------------------------------------------------------------------------
// 2. The request-scope sweep
//
// Since 0051 a request scope IS a database transaction carrying `set local
// app.user_id`. Touching the store outside one does not raise a permission
// error — lib/db.ts's fail-closed Proxy throws only if no handle exists at all,
// and a handle that has escaped its scope reads as a user of NULL, which every
// policy denies. So the symptom is EMPTY RESULTS, everywhere, with no error.
//
// This sweep is how the account page was found throwing "sql used outside a
// withUser() scope": requireUser() authenticates but does NOT open a scope, and
// four call sites were still using it.
// ---------------------------------------------------------------------------
const SCOPE_EXEMPT: Record<string, string> = {
  "app/api/auth/me/route.ts": "pure Supabase session read, no store call",
  "app/auth/actions.ts": "sign in / sign up / sign out, no store call",
  "app/auth/callback/route.ts": "verifyOtp only, runs before a profile exists",
};

const SCOPE_ENTRIES = /withPageUser|withRequestUser|withRequestConfig/;
const STORE_IMPORT = /@\/lib\/(rag|auth|batch|llm)/;

function isEntryPoint(path: string) {
  return /(?:^|\/)(?:route|actions)\.ts$|(?:^|\/)(?:page|layout)\.tsx$/.test(path);
}

function sweepScopes() {
  console.log("\n2. request scopes on app entry points\n");
  const files = walk(join(ROOT, "app"), isEntryPoint);
  let checked = 0;

  for (const file of files) {
    const path = rel(file);
    const source = read(file);
    if (!STORE_IMPORT.test(source)) continue;
    checked++;

    if (SCOPE_ENTRIES.test(source)) continue;
    const why = SCOPE_EXEMPT[path];
    if (!why) {
      fail(`${path} — imports the store but enters no request scope`);
    }
  }

  console.log(`   ${checked} store-touching entry points, ${Object.keys(SCOPE_EXEMPT).length} exempt:`);
  for (const [path, why] of Object.entries(SCOPE_EXEMPT)) {
    console.log(`   ${path.padEnd(34)} ${why}`);
  }
}

// ---------------------------------------------------------------------------
// 3. The authentication boundary, per METHOD
//
// proxy.ts deliberately does not redirect /api (a fetch that follows a 307 to
// /login and parses the HTML as JSON reports an error with nothing to do with
// the real problem), so each handler returns its own 401 — which the wrappers in
// lib/http/configScope.ts do.
//
// PER METHOD, NOT PER FILE, and that distinction is the entire reason this
// exists. Phase 2's first sweep was file-level, passed, and left ten handlers
// open: each shared a file with a gated sibling, so the filename matched.
// ---------------------------------------------------------------------------
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const GATES = /withRequestUser|withRequestConfig|requireUserForApi|requireUser\(/;

const HANDLER_EXEMPT: Record<string, string> = {
  "app/auth/callback/route.ts:GET": "the email confirmation link itself — no session yet, by definition",
};

function sweepApiGates() {
  console.log("\n3. authentication boundary, per exported handler\n");
  const files = walk(join(ROOT, "app"), (p) => p.endsWith("route.ts"));
  let handlers = 0;

  for (const file of files) {
    const path = rel(file);
    const source = read(file);

    // Find each exported handler and slice its body to the next top-level
    // export. Crude on purpose: a nested `export` at column 0 would end the
    // slice early, which can only ever produce a FALSE ALARM, never a miss.
    const pattern = new RegExp(
      `^export\\s+(?:async\\s+)?(?:function|const)\\s+(${HTTP_METHODS.join("|")})\\b`,
      "gm",
    );
    const starts: { method: string; index: number }[] = [];
    for (const m of source.matchAll(pattern)) {
      starts.push({ method: m[1], index: m.index });
    }

    for (let i = 0; i < starts.length; i++) {
      handlers++;
      const next = source.indexOf("\nexport ", starts[i].index + 1);
      const end = next === -1 ? source.length : next;
      const body = source.slice(starts[i].index, end);
      const key = `${path}:${starts[i].method}`;

      if (GATES.test(body)) continue;
      if (HANDLER_EXEMPT[key]) continue;
      fail(`${key} — handler body reaches no authentication gate`);
    }
  }

  console.log(`   ${handlers} handlers across ${files.length} route files`);
  for (const [key, why] of Object.entries(HANDLER_EXEMPT)) {
    console.log(`   ${key.padEnd(34)} exempt: ${why}`);
  }
}

sweepExpose();
sweepScopes();
sweepApiGates();

console.log(
  failures === 0
    ? "\nOK — keys stay wrapped, scopes are entered, every handler is gated."
    : `\nFAILED — ${failures} violation(s).`,
);
if (failures) process.exitCode = 1;
