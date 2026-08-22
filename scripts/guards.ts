// Six greppable invariants, none of which a typecheck, a unit test or a page that
// renders one account's data can see. The first three have each already been
// violated once; the fourth guards a column that fails silently; the fifth guards
// a package whose mere presence in the module graph broke every background job in
// production; the sixth stands between an unauthenticated endpoint and someone
// else's provider bill.
//
//   1. .expose() appears only where a provider client is constructed.
//   2. Every app entry point that touches the store enters a request scope.
//   3. Every API handler is behind the authentication boundary — per METHOD.
//   4. Every read of eval_results has a view on is_baseline (0057).
//   5. @huggingface/transformers is never imported for its VALUE at module scope.
//   6. Every route that spends or ships vectors calls the guest-demo gate.
//
// WHY GREP AND NOT THE TYPE SYSTEM. All six are properties of where a call (or a
// column) APPEARS, not of what it returns, so no signature could encode them. The
// mitigation for grep's bluntness is that every sweep asserts an allowlist: a new
// violation fails by name, and a deliberate exception has to be added here with a
// reason next to it.
//
//   Usage: npm run guard   (no database, no network, no env)
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

// 1. The .expose() allowlist
//
// lib/crypto/secretKey.ts wraps a decrypted provider key so it cannot reach a log,
// a JSON response or a stack trace by accident: only .expose() yields the real
// string. The wrapper is worth exactly as much as the discipline about where that
// call appears, and nothing but this sweep enforces it.
//
// The rule is "inline at the construction site" — `build(secret.expose())`, not
// `const key = secret.expose()`, because a local variable is a plain string that
// outlives the expression and can be logged, spread or serialised downstream.
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

// 2. The request-scope sweep
//
// Since 0051 a request scope IS a database transaction carrying `set local
// app.user_id`. Touching the store outside one does not raise a permission error —
// the fail-closed Proxy throws only if no handle exists at all, and a handle that
// has escaped its scope reads as a user of NULL, which every policy denies. So the
// symptom is EMPTY RESULTS, everywhere, with no error.
//
// This sweep is how the account page was found throwing "sql used outside a
// withUser() scope": requireUser() authenticates but does NOT open a scope.
const SCOPE_EXEMPT: Record<string, string> = {
  // app/api/auth/me/route.ts used to be here ("pure Supabase session read, no
  // store call"). It reads guestStatus() now, which is a store call, so it
  // enters a scope like everything else and no longer needs the exemption.
  "app/api/demo/start/route.ts":
    "guest provisioning — deliberately cross-tenant (privilegedSql), and the one " +
    "scoped call it makes (sealing the Voyage key) opens the guest's own scope inside " +
    "provisionGuest rather than wrapping a handler that has no session to scope to",
  "app/auth/actions.ts": "sign in / up / out and password reset — Supabase Auth only, no store call",
  "app/auth/callback/route.ts": "verifyOtp only, runs before a profile exists",
  "app/auth/reset/page.tsx": "session + recovery-cookie check only, no store call",
  "app/oauth/consent/page.tsx": "OAuth consent — Supabase Auth only, no store call",
  "app/api/oauth/decision/route.ts": "OAuth approve / deny — Supabase Auth only, no store call",
};

// The MCP pair from lib/http/mcpScope.ts, listed for the same reason as their
// cookie siblings: /api/mcp touches the store, so it must open a scope, and
// matching by name is what makes that checkable without running anything.
// withMcpRequest is what a route calls (it gates, then opens the scope);
// withMcpUser is the scope itself, for anything entering it directly.
// withJobSecret (lib/http/jobSecret.ts) is the boundary for /api/jobs/tick, the
// one route with no session — a shared-secret signature over the job id. It opens
// no scope itself; the runner it calls resolves the job's OWNER and enters that
// user's scope (runSlice → inOwnScope), which is why the tick route's handler body
// legitimately shows a gate but no scope entry. runSlice is named here so that
// stays checkable rather than being an exemption.
const SCOPE_ENTRIES =
  /withPageUser|withRequestUser|withRequestConfig|withMcpRequest|withMcpUser|runSlice|sweepStalledJobsAcrossUsers/;
const STORE_IMPORT = /@\/lib\/(rag|auth|batch|llm|jobs)/;

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

// 3. The authentication boundary, per METHOD
//
// proxy.ts deliberately does not redirect /api (a fetch that follows a 307 to
// /login and parses the HTML as JSON reports an error with nothing to do with the
// real problem), so each handler returns its own 401.
//
// PER METHOD, NOT PER FILE, and that distinction is the entire reason this exists.
// The first sweep was file-level, passed, and left ten handlers open: each shared a
// file with a gated sibling, so the filename matched.
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
// withMcpRequest (lib/http/mcpScope.ts) is the bearer-token boundary for
// /api/mcp: it verifies the OAuth token, rejects anything that is not an MCP
// token, and enforces the mcp_enabled kill switch. It belongs in this list for
// exactly the same reason withRequestUser does.
// withJobSecret belongs here for the same reason withMcpRequest does: it is an
// authentication boundary whose credential is not a cookie. It verifies an HMAC
// over the job id (or a bearer secret for the cron sweep) before any work is
// scheduled, and it is the ONLY gate allowed to stand in for a session.
const GATES =
  /withRequestUser|withRequestConfig|requireUserForApi|requireUser\(|withMcpRequest|withJobSecret/;

const HANDLER_EXEMPT: Record<string, string> = {
  "app/auth/callback/route.ts:GET": "the email confirmation link itself — no session yet, by definition",
  // RFC 9728 discovery. A client fetches these to find out WHERE to get a
  // credential, so requiring one would be circular — the 401 challenge on
  // /api/mcp points at them by design. They serve two public URLs (this
  // server's identity and Supabase's issuer) and read nothing user-specific.
  "app/api/mcp-discovery/protected-resource/route.ts:GET":
    "unauthenticated OAuth discovery — RFC 9728, read before any credential exists",
  "app/api/mcp-discovery/protected-resource/route.ts:OPTIONS": "CORS preflight for the above",
  "app/api/mcp-discovery/authorization-server/route.ts:GET":
    "unauthenticated OAuth discovery — RFC 8414 pass-through for pre-9728 clients",
  "app/api/mcp-discovery/authorization-server/route.ts:OPTIONS": "CORS preflight for the above",
  // THE GUEST DEMO'S FRONT DOOR. Unauthenticated by definition — its whole
  // purpose is to serve someone who has no account — so no session gate can
  // apply. What stands in its place is a pair of caps checked before anything is
  // created: a per-address provisioning limit and a live-guest ceiling
  // (lib/demo/rateLimit.ts, lib/demo/config.ts). Listed here so that trade is on
  // the record rather than looking like a route somebody forgot.
  "app/api/demo/start/route.ts:POST":
    "unauthenticated by definition — rate-limited per IP and capped on live guests instead",
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

// 4. Every read of eval_results excludes baseline rows
//
// 0057 puts SHADOW rows in eval_results: the same questions measured with no
// per-chunk overrides in effect. They are not results of the retrieval anyone is
// running, and a read that mistakes one for "the latest result" does silent damage
// rather than failing — a baselined question looks already-scored to
// questionsNeedingScoring and never gets a real score.
//
// The invariant is per QUERY, not per file: every `from eval_results` must MENTION
// is_baseline in the same statement. Mentioning, not excluding — two queries read
// baseline rows on purpose, and no grep can tell a correct `where is_baseline` from
// a wrong one. What it does catch is a new query written by someone who has never
// heard of 0057, which omits the column entirely.
function sweepBaselineReads() {
  console.log("\n4. eval_results reads exclude baseline rows\n");
  const files = walk(join(ROOT, "lib"), (p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  files.push(...walk(join(ROOT, "app"), (p) => p.endsWith(".ts") || p.endsWith(".tsx")));

  let reads = 0;
  for (const file of files) {
    const source = read(file);
    const path = rel(file);
    // Split on the tagged-template boundary so each statement is judged alone.
    const statements = source.split("sql");
    let unguarded = 0;
    for (const stmt of statements) {
      // `from eval_results` = a read. Inserts say `into eval_results`; the one
      // update targets it by name and is matched by its own `from eval_results`
      // subselect, which is a read and does need the filter.
      if (!/\bfrom\s+eval_results\b/.test(stmt)) continue;
      reads++;
      if (!/\bis_baseline\b/.test(stmt)) unguarded++;
    }
    if (unguarded === 0) continue;
    fail(`${path} — ${unguarded} eval_results read(s) that never mention is_baseline`);
  }

  console.log(`   ${reads} eval_results read(s) across ${files.length} files, all accounted for`);
}

// 5. The transformers barrel
//
// @huggingface/transformers' Node entry does a static, top-level
// `import * as ONNX_NODE from "onnxruntime-node"`. Importing ANY value from the
// package — even AutoTokenizer, which is pure JS — therefore loads a 26 MB native
// runtime whose platform binary @vercel/nft cannot trace, and every route that
// could reach it 500'd in production for weeks. See
// docs/serverless-bundle-fix-plan.md; chunking now goes through
// lib/rag/tokenizerLoader.ts and @huggingface/tokenizers instead.
//
// Two forms stay legal, because neither puts the package in the serverless module
// graph: a TYPE-ONLY import, which erases at compile time, and the single dynamic
// `import()` in the local embedding adapter, which is unreachable unless
// LOCAL_EMBEDDINGS is set and so never fires on a deployment.
//
// A source sweep rather than a trace check because this is the form the mistake
// takes: someone wants a tokenizer, reaches for the package they know, and the
// build stays green. scripts/trace-guard.ts checks the other end — the artifact.
const TRANSFORMERS = "@huggingface/transformers";
const TRANSFORMERS_DYNAMIC_ALLOWED: Record<string, string> = {
  "lib/rag/embeddingProviders.ts":
    "await import() in the local adapter, gated behind LOCAL_EMBEDDINGS",
};

function sweepTransformersBarrel() {
  console.log(`\n5. ${TRANSFORMERS} stays out of the module graph\n`);
  const files = [
    ...walk(join(ROOT, "lib"), (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
    ...walk(join(ROOT, "app"), (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
  ];
  let statics = 0;

  for (const file of files) {
    const path = rel(file);
    const lines = read(file).split("\n");

    lines.forEach((line, i) => {
      // Comments describe this rule at length in several files; the words are
      // not imports.
      const code = line.replace(/\/\/.*$/, "");
      if (!code.includes(TRANSFORMERS)) return;

      // Erased at compile time — costs the bundle nothing.
      if (/^\s*import\s+type\s/.test(code)) return;

      if (/\bimport\s*\(/.test(code) || /\brequire\s*\(/.test(code)) {
        const why = TRANSFORMERS_DYNAMIC_ALLOWED[path];
        if (!why) {
          fail(`${path}:${i + 1} — dynamic import of ${TRANSFORMERS} outside the allowlist in scripts/guards.ts`);
        }
        return;
      }

      statics++;
      fail(
        `${path}:${i + 1} — value import of ${TRANSFORMERS}; use ` +
          `@/lib/rag/tokenizerLoader for tokenizers, or import type only`,
      );
    });
  }

  if (statics === 0) {
    console.log(`   no value imports; ${Object.keys(TRANSFORMERS_DYNAMIC_ALLOWED).length} allowed dynamic import(s):`);
    for (const [path, why] of Object.entries(TRANSFORMERS_DYNAMIC_ALLOWED)) {
      console.log(`   ${path.padEnd(32)} ${why}`);
    }
  }
}

// 6. Every spending route is behind the demo gate
//
// A guest's workspace is provisioned by an UNAUTHENTICATED endpoint and holds
// the operator's Voyage key. The only thing between that and a stranger running
// autotune on someone else's money is assertDemoAllows() being present at each
// entry point — and "present at each entry point" is exactly the property that
// erodes one new route at a time.
//
// THE LIST IS THE SPEC, not a snapshot: a route named here that loses its gate
// fails by name. It cannot catch the opposite mistake — a NEW spending route
// that nobody adds here — which is why the list is grouped by what it protects
// rather than alphabetised, so an omission reads as a gap in a category.
const DEMO_GATED: Record<string, string> = {
  // spends the shared embedding key
  "app/api/ingest/route.ts": "upload + ingest",
  "app/api/ingest/library/route.ts": "ingest from the document library",
  "app/api/corpora/[id]/documents/route.ts": "adding a document ingests it",
  "app/api/configs/[id]/populate/route.ts": "populates a config's chunks",
  "app/api/configs/[id]/reconfigure/route.ts": "re-chunks, i.e. re-embeds the corpus",
  "app/api/eval/autotune/route.ts": "re-embeds every chunk it tries",
  "app/api/eval/autotune/apply/route.ts": "applies an autotune result, re-embedding",
  "app/api/semantic-cache/key-model/route.ts": "re-embeds the question bank per model",
  "app/api/semantic-cache/pairs/route.ts": "generates + embeds calibration pairs",
  // spends an answer-model key the demo does not carry
  "app/api/eval/questions/generate/route.ts": "question generation",
  "app/api/eval/bulk-generate/route.ts": "bulk question generation",
  "app/api/eval/bulk-llm-ndcg/route.ts": "LLM ranking",
  "app/api/eval/questions/[id]/explain/route.ts": "LLM explanation",
  "app/api/semantic-cache/shadow/judge/route.ts": "LLM judge",
  "app/api/clusters/[id]/label/route.ts": "LLM cluster labels",
  // ships VECTORS to the app server — cheap in dollars, ruinous in egress
  "app/api/clusters/run/route.ts": "clusterStore pulls every chunk embedding",
  "app/api/eval/rescore/route.ts": "chunkEmbeddings() pulls vectors",
  "app/api/eval/process/route.ts": "chunkEmbeddings() pulls vectors",
  "app/api/eval/bulk-ndcg/route.ts": "chunkEmbeddings() pulls vectors",
  "app/api/eval/chunks/[chunkId]/try-model/route.ts": "embeds a chunk under another model",
  // spends later, when the workspace no longer exists
  "app/api/batch/submit/route.ts": "provider batch submission",
  // the other door into three of the above
  "app/api/jobs/route.ts": "background launch of rescore / bulk_ndcg / autotune",
};

function sweepDemoGates() {
  console.log("\n6. spending routes behind the demo gate\n");
  for (const [path, why] of Object.entries(DEMO_GATED)) {
    let source: string;
    try {
      source = read(join(ROOT, path));
    } catch {
      fail(`${path} — named in DEMO_GATED but the file does not exist`);
      continue;
    }
    if (!/assertDemoAllows\(/.test(source)) {
      fail(`${path} — spends or ships vectors (${why}) but never calls assertDemoAllows()`);
    }
  }
  console.log(`   ${Object.keys(DEMO_GATED).length} routes named, all gated`);
}

sweepExpose();
sweepScopes();
sweepApiGates();
sweepBaselineReads();
sweepTransformersBarrel();
sweepDemoGates();

console.log(
  failures === 0
    ? "\nOK — keys stay wrapped, scopes are entered, every handler is gated, " +
        "baseline rows stay out of live reads, no guest can spend, and the "
        + "transformers barrel is unimported."
    : `\nFAILED — ${failures} violation(s).`,
);
if (failures) process.exitCode = 1;
