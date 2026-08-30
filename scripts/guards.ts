// Seven greppable invariants, none of which a typecheck, a unit test or a page that
// renders one account's data can see. The first three have each already been
// violated once; the fourth guards a column that fails silently; the fifth guards
// a package whose mere presence in the module graph broke every background job in
// production; the sixth stands between an unauthenticated endpoint and someone
// else's provider bill; the seventh keeps a calibration pass from becoming a
// cache-poisoning one.
//
//   1. .expose() appears only where a provider client is constructed.
//   2. Every app entry point that touches the store enters a request scope.
//   3. Every API handler is behind the authentication boundary — per METHOD.
//   4. Every read of eval_results has a view on is_baseline (0057).
//   5. @huggingface/transformers is never imported for its VALUE at module scope.
//   6. Every route that spends or ships vectors calls the guest-demo gate.
//   7. The probe replay path never serves, banks or judges.
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
  "app/api/eval/bulk-ndcg/route.ts": "aggregate ranking embeds a pool under every model",
  "app/api/eval/chunks/[chunkId]/try-model/route.ts": "embeds a chunk under another model",
  "app/api/eval/questions/[id]/ranking/route.ts": "aggregate ranking embeds a pool under every model",
  "app/api/eval/chunks/[chunkId]/override/route.ts": "re-embeds a chunk, then rescores it",
  // spends later, when the workspace no longer exists
  "app/api/batch/submit/route.ts": "provider batch submission",
  // guards the SCOPE the two ungated levers rely on — see sweepDemoScope
  "app/api/eval/questions/[id]/ignore/route.ts": "un-ignoring thaws a frozen question",
  // the other door into one of the above
  "app/api/jobs/route.ts": "background launch of bulk_ndcg",
};

// 6b. The frozen scope is still in the two queries that spend on its behalf.
//
// Re-score and autotune are NOT in the table above any more: phase 4 of
// docs/demo-analytics-plan.md scopes them instead of blocking them, and the whole
// of that scope is two `not exists` clauses in evalStore. Delete them — or
// "simplify" the shared fragment away — and nothing fails: a guest just quietly
// gets a re-score button pointed at 472 questions and an autotune with 460
// candidates. That is the same erosion sweep 6 exists to catch, one indirection
// further in, so it gets the same treatment.
const DEMO_SCOPED: { file: string; needles: string[]; why: string }[] = [
  {
    file: "lib/rag/evalStore.ts",
    needles: ["const notFrozen", "${notFrozen()}"],
    why: "the frozen-set scope on questionsNeedingScoring + allLabeledQuestions",
  },
  {
    file: "lib/demo/clone.ts",
    needles: [
      "freezeAllBut",
      "FROZEN_REASON",
      "limit: BANKED_QUESTION_CAP",
      "SHADOW_CURVE_CAP.probe",
      "SHADOW_QUEUE_CAP",
      "PUBLISHED_REPLAY_FINGERPRINT",
      "PUBLISHED_SWEEP_FINGERPRINT",
    ],
    why:
      "the publish hop that writes the frozen set, the cap on the banked " +
      "questions a guest can ADD to it (a question a guest adds is unfrozen, so " +
      "an uncapped bank is an uncapped autotune set), the two caps on the " +
      "shadow-log SAMPLE (step 5b is the clone's only sampling copy — the table " +
      "grows every time the operator asks a question, so an uncapped copy is a " +
      "guest's disk tracking the master's bookkeeping), and the sentinel step 5c " +
      "rewrites the replay's fingerprint to (copied under the master's own md5, " +
      "the rows are present but unreachable and the demo's model comparison " +
      "renders empty while the table says it is populated), and the same sentinel " +
      "for the cache-key sweep step 5d carries (0077 has no other reader, so a " +
      "copied real fingerprint would leave a guest's §4 dark with the row sitting " +
      "right there)",
  },
  // Phase 6.3 makes the demo's model comparison a BUILD ARTIFACT living in a
  // cache table. The read path can only find it under the sentinel, and
  // writeCached — which exists to evict stale generations — would otherwise take
  // it with them the first time anyone opens /appraise/models as the snapshot
  // account. That is a silent eviction: a cold replay over an empty
  // embedding_cache is not an error, it is seventeen unscorable rows, and the
  // next guest is cloned from those.
  {
    file: "lib/rag/replayStore.ts",
    needles: ["and fingerprint <> ${PUBLISHED_REPLAY_FINGERPRINT}"],
    why: "the published generation is exempt from the cache's own eviction",
  },
  // Phase 6 opened ONE form of bulk-generate to a guest: `cachedOnly`, which
  // reads question_cache and calls no model. Sweep 6 above still passes if that
  // condition WIDENS — the file keeps its assertDemoAllows() either way — so the
  // condition itself is pinned here. This is the whole difference between "a
  // guest may add a question that was already paid for" and "a guest may spend
  // the operator's answer-model key", and it is one boolean long.
  {
    file: "app/api/eval/bulk-generate/route.ts",
    needles: ['if (!body.data.cachedOnly) await assertDemoAllows("generate")'],
    why: "the carve-out is exactly the cachedOnly flag and nothing wider",
  },
  // Phase 6.2 opened the same shape on the shadow judge: `human` is one UPDATE on
  // a row the caller owns, `llm` buys tokens. Sweep 6 keeps passing however wide
  // this condition grows, since the file keeps its gate call either way, so the
  // condition is the needle. The demo's calibration workbench is downstream of
  // this one line.
  {
    file: "app/api/semantic-cache/shadow/judge/route.ts",
    needles: [
      'if (body.mode !== "human") await assertDemoAllows("judge")',
      // Phase 4 of docs/demo-cache-replay-plan.md turned the OTHER mode from a
      // refusal into a replay: the bulk pass applies the verdicts the operator's
      // judge really returned. The gate above still stands unconditionally behind
      // it — replayJudgeQueue answers only a guest — so this needle is what keeps
      // the two lines in that order, which is the whole of the spend argument.
      "const replayed = body.mode === \"llm\" ? await replayJudgeQueue(body) : null;",
    ],
    why: "the carve-out is exactly the human verdict mode, plus a replay that spends nothing",
  },
  // Phase 2 of docs/demo-cache-lab-plan.md SPLIT one gate into three lines, and
  // the split is the only thing separating "a guest may read a sweep the operator
  // paid for" from "a guest may re-embed ~510 texts under every candidate model".
  // Sweep 6 cannot see any of it: the file keeps calling assertDemoAllows
  // whatever these three lines say. Each is pinned:
  //   1. the WRITES stay blocked, and under their own sentence;
  //   2. the replay is gated on being a GUEST — replaySweepResult refuses every
  //      other account — because the operator's own workspace owns a matrix too
  //      (it is the account that captured it), and handing that back instead of
  //      running the sweep would be a measurement implying a computation that did
  //      not happen;
  //   3. the fallback for a build published WITHOUT a matrix is still a refusal.
  //      Phase 5 kept this line where the plan had it deleted, and the reason is
  //      in scripts/demo-snapshot: the matrix is captured only under --sweep, and
  //      its absence WARNS rather than fails. A routine cheap republish is exactly
  //      a build whose guests reach line 3, and without it their click buys ~510
  //      texts under every candidate model on the operator's key.
  {
    file: "app/api/semantic-cache/key-model/route.ts",
    needles: [
      'if (data.action !== "sweep") await assertDemoAllows("keyModel");',
      'const replay = data.action === "sweep" ? await replaySweepResult() : null;',
      'if (data.action === "sweep") await assertDemoAllows("sweep");',
    ],
    why: "the per-action gate: only `sweep` replays, and only for a guest",
  },
  // The generate and screen carve-outs, whose needles are shaped differently from
  // cachedOnly's on purpose: there is no body flag to pin, because THE CARVE-OUT
  // IS THE FUNCTION. Every read in lib/demo/replayView returns null for anyone who
  // is not a guest, so both routes keep an UNCONDITIONAL assertDemoAllows after
  // the branch (sweep 6 keeps meaning what it says) and both fail closed — delete
  // the line and a guest is simply refused, as they were before the demo had a
  // matrix to replay.
  {
    file: "app/api/semantic-cache/pairs/route.ts",
    needles: [
      "const advanced = await advanceReplay(body.data.limit ?? DEFAULT_REVEAL);",
      'await assertDemoAllows("pairs")',
    ],
    why: "the generate carve-out walks the banked matrix, with the gate still unconditional behind it",
  },
  {
    file: "app/api/batch/submit/route.ts",
    needles: [
      'const banked = kind === "cache_pair_screen" ? await screenReplay() : null;',
      'await assertDemoAllows("batch")',
    ],
    why: "the pair-screen carve-out is one named kind, and no other",
  },
  // The Eval tab's three shelf-before-gate lines (phases 5 and 6 of
  // docs/demo-real-flow-plan.md). Each is the same one-expression shape the
  // key-model sweep's three lines are, and sweep 6 cannot see any of it: all
  // three files keep calling assertDemoAllows whatever the condition says.
  // What each line buys, and what its loss costs:
  //
  //   • the READ COMES FIRST, so a build published WITH the master's answer
  //     replays it and a build published WITHOUT one is refused. Invert the two
  //     and every guest is refused, which is a silent regression to phase 4 —
  //     the buttons render live (the summary asks the same shelf) and then 403.
  //   • the gate is UNCONDITIONAL behind the read, so the fallback is a refusal
  //     and never a real embed on the operator's key. `sweep`'s lesson, and the
  //     routine cheap republish is exactly the build that reaches it.
  {
    file: "app/api/eval/bulk-ndcg/route.ts",
    needles: ['if ((await readIdeals()) === null) await assertDemoAllows("rank");'],
    why: "the ideals carve-out: replay a published aggregate order, refuse without one",
  },
  {
    file: "app/api/eval/bulk-llm-ndcg/route.ts",
    needles: ['if ((await readLlmRankings()) === null) await assertDemoAllows("llmRank");'],
    why: "the llm_rerank carve-out, on the ideals' terms exactly",
  },
  // The autotune's copy of the same shape, one layer in: the gate lives in the
  // STEP rather than the route, because the search phase is what spends and a
  // sliced job re-enters it. The ternary is pinned beside the gate for a reason
  // the other two do not have — here the two branches are a replay and a REAL
  // per-chunk search under every candidate model, so a `tuning ?? …` slip would
  // run the expensive one for a guest whose shelf is stocked.
  {
    file: "lib/jobs/steps/autotune.ts",
    needles: [
      "const tuning = await readTuning();",
      'if (tuning === null) await assertDemoAllows("autotune");',
      "? runSearch(planned, emit, shouldStop)",
      ": runReplay(planned, tuning, emit, shouldStop)",
    ],
    why: "the tuning carve-out, and that a stocked shelf takes runReplay rather than runSearch",
  },
  // Start over spends nothing, so it is deliberately outside DEMO_ACTIONS (§4.7)
  // — which means the ONE thing standing between a real account and a request
  // that deletes its eval board is this line. The route reads a null and answers
  // 403; delete the line and the null never comes.
  {
    file: "lib/demo/restart.ts",
    needles: ["if (!(await isGuest())) return null;"],
    why: "the reset is guest-only from the module, since no gate covers it",
  },
  // The needle that matters most of the four. Every carve-out above is safe only
  // because the matrix's readers refuse everyone who is not a guest; lose this and
  // a replayed measurement can be served to the account that made it.
  {
    file: "lib/demo/replay.ts",
    needles: ["if (!(await isGuest())) return null;"],
    why: "the matrix's readers are guest-only, which is what stops every carve-out on that page widening",
  },
];

function sweepDemoScope() {
  console.log("\n6b. the demo's frozen scope\n");
  for (const { file, needles, why } of DEMO_SCOPED) {
    let source: string;
    try {
      source = read(join(ROOT, file));
    } catch {
      fail(`${file} — named in DEMO_SCOPED but the file does not exist`);
      continue;
    }
    const missing = needles.filter((n) => !source.includes(n));
    if (missing.length > 0) {
      fail(
        `${file} — lost ${missing.join(", ")}, i.e. ${why}. Re-score and autotune ` +
          `are ungated for a guest BECAUSE of this; without it they are unbounded.`,
      );
    }
  }
  // The two ungated routes, asserted from the other end: if one of them grows a
  // gate back, the scope stopped being trusted and this file should say why.
  const expectedOpen = ["app/api/eval/rescore/route.ts", "app/api/eval/process/route.ts"];
  for (const path of expectedOpen) {
    if (/assertDemoAllows\(/.test(read(join(ROOT, path)))) {
      fail(`${path} — gated again, but still relied on as SCOPED in lib/demo/policy.ts`);
    }
  }
  const readers = sweepDemoReaders();
  console.log(
    `   ${DEMO_SCOPED.length} scope sites intact, ${expectedOpen.length} routes open, ` +
      `${readers} readers guest-only`,
  );
}

// 6c. EVERY reader of the demo's store answers a real account with null.
//
// The single needle in DEMO_SCOPED above pinned the carve-out when replay.ts had
// one reader in it. It now has seven — the matrix, the board, the two ranking
// kinds, progress, the shadow verdicts and the tuning — and a needle that only
// asks whether the string appears SOMEWHERE in the file passes just as happily
// with six of them guarded. So the readers are enumerated instead: a new kind
// added without the line fails by name, which is the shape this whole file is.
//
// A reader is covered if it carries the line itself, or if it delegates to one
// that does — readIdeals and readLlmRankings are two views of readRankings, and
// making them repeat the check would be the duplication, not the guard.
const GUEST_CARVE_OUT = "if (!(await isGuest())) return null;";

function sweepDemoReaders(): number {
  const file = "lib/demo/replay.ts";
  const source = read(join(ROOT, file));
  // Declaration sites in order, so each body is the slice up to the next one.
  const decls = [...source.matchAll(/^(?:export )?async function (\w+)\b/gm)];
  const bodies = new Map<string, string>();
  decls.forEach((d, i) => {
    const start = d.index ?? 0;
    const end = i + 1 < decls.length ? (decls[i + 1].index ?? source.length) : source.length;
    bodies.set(d[1], source.slice(start, end));
  });
  const readers = [...bodies.keys()].filter((name) => /^read[A-Z]/.test(name));
  if (readers.length === 0) {
    fail(`${file} — no read* functions found at all; the census below asserts nothing`);
    return 0;
  }
  const covered = new Set(readers.filter((n) => bodies.get(n)!.includes(GUEST_CARVE_OUT)));
  // One pass of delegation is enough today; loop anyway so a second layer of
  // indirection does not turn into a false failure that invites deleting this.
  for (let pass = 0; pass < readers.length; pass++) {
    for (const name of readers) {
      if (covered.has(name)) continue;
      const body = bodies.get(name)!;
      for (const [other, otherBody] of bodies) {
        if (other === name || !body.includes(`${other}(`)) continue;
        if (otherBody.includes(GUEST_CARVE_OUT) || covered.has(other)) covered.add(name);
      }
    }
  }
  for (const name of readers) {
    if (!covered.has(name)) {
      fail(
        `${file}:${name} — reads the demo's store without \`${GUEST_CARVE_OUT}\` and ` +
          `without delegating to a reader that has it. Every carve-out in DEMO_SCOPED ` +
          `is safe only because a real account reads null here.`,
      );
    }
  }
  return readers.length;
}

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

// 7. The probe path cannot poison the cache it measures
//
// Probe replay pushes generated pair texts back through the REAL lookup. That is
// the point of it — a probe has to be what the cache would have done — and it is
// also why the pass is one wrong option away from being destructive:
//
//   • serve:true would let the caller bank the variant just replayed, and the
//     next pass would self-match it at cosine 1.0 (scripts/f1-negatives.ts:25).
//   • a missing origin 'probe' would file synthetic near-misses as traffic, which
//     is what the live threshold recommendation reads (0069) and what the
//     key-model sweep trusts over the audited pair label (the F3 defect).
//   • a verdict written from the pair's own label would let a generator F3
//     measured at 80% correct move a LIVE serving threshold.
//
// None of the three fails loudly. A typecheck cannot see them either: they are
// properties of which VALUE reaches a call and which symbols appear in a file,
// which is exactly what this file is for. The unit half — that PROBE_LOOKUP holds
// the right four options — is in lib/rag/probeReplayCore.test.ts; this sweep is
// what stops someone passing something else.

// Every module in the probe-replay path. Named rather than globbed: a new file
// here is a decision, and it should have to be added deliberately.
const PROBE_FILES = [
  "lib/rag/probeReplay.ts",
  "lib/rag/probeReplayCore.ts",
  "lib/rag/probeReplayTrigger.ts",
  "lib/jobs/steps/probeReplay.ts",
  // Phase 4 of docs/demo-cache-lab-plan.md: a SECOND entry into the same work,
  // one probe at a time and by hand. It shares the path's rails for the same
  // reason the job does — it lands rows in the queue a live τ is swept from.
  // Phase 5 took it out of the DEMO, not out of the app; it is a real account's
  // button now, and every rail below applies to it unchanged.
  "app/api/semantic-cache/probe/route.ts",
];

// 7f's requirements on that route.
//
// The floor is the load-bearing one. A research pass records everything (F2's
// origin split), but this route stocks a queue whose other rows came from
// lib/demo/clone step 5b, which strides a sample at the CONFIGURED floor — so a
// 0.4 near-miss landing among them would be a row about the demo rather than
// about the cache, judged by a visitor who cannot tell the difference. That
// argument survives phase 5 hiding the button: the queue it describes is the
// operator's own, and a real account's probe lands in it beside the same rows.
const REQUIRED_IN_PROBE_ROUTE: Record<string, string> = {
  "config.semanticCache.shadowLogFloor":
    "the probe must record at the CONFIGURED floor, not PROBE_LOOKUP's 0",
  poolSafeProbes: "quarantined pairs are dropped before the choice, not after",
  selectOneProbe: "the F3 collision assertion is what makes the choice safe",
};

// What this route may never become. The bulk job stays blocked in the demo
// (DEMO_ACTIONS.probeReplay, 40 probes nobody pressed a button for); a route
// that grew a cap or reached launchJob would be a second door into exactly what
// the gate refuses, opened from the side that has no gate at all.
//
// STILL TRUE AFTER PHASE 5, which HID this route's button from the demo rather
// than gating the route. A guest reaching it now has no eligible pair and gets
// NOTHING_ELIGIBLE — but "the UI does not offer it" is not a spend limit, and the
// day something makes a pair eligible again this cap is the only thing standing
// between one probe and forty.
const FORBIDDEN_IN_PROBE_ROUTE: Record<string, string> = {
  launchJob: "one probe by hand is the whole point — the bulk job stays blocked",
  PROBE_CAP: "a cap means this route is running more than one probe",
};

// Symbols that BANK an answer or WRITE a verdict. Neither belongs anywhere in the
// probe path: probe rows stock the queue, and a human or the metered judge fills
// the verdict in.
const FORBIDDEN_IN_PROBE_PATH: Record<string, string> = {
  semanticCacheStore: "banks an answer — a probe must leave semantic_cache untouched",
  backfillKeyModel: "the other writer of semantic_cache — same rule as banking",
  setPairVerdict: "writes a pair verdict — probe rows land unjudged by design",
  judgeOne: "spends on the judge — the probe pass only stocks the queue for it",
  judgeShadowEvents: "spends on the judge — the probe pass only stocks the queue for it",
};

// These files explain at length what they do NOT do, and the prose must not trip
// the sweep that checks the code.
const codeOnly = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

function sweepProbeReplay() {
  console.log("\n7. the probe replay path cannot poison the cache\n");

  const source = codeOnly(read(join(ROOT, "lib/rag/probeReplay.ts")));

  // 7a. The lookup is called with the frozen constant, never a literal. An inline
  // object literal is how the next caller quietly drops serve:false.
  const calls = [...source.matchAll(/semanticCacheLookup\(([^)]*)/g)];
  if (calls.length !== 1) {
    fail(
      `lib/rag/probeReplay.ts — expected exactly 1 semanticCacheLookup call, found ${calls.length}`,
    );
  }
  for (const call of calls) {
    if (!/\bPROBE_LOOKUP\b/.test(call[1])) {
      fail(
        "lib/rag/probeReplay.ts — semanticCacheLookup called with something other than " +
          "PROBE_LOOKUP; the options must stay a single asserted value",
      );
    }
  }

  // 7b. The constant itself still says serve:false. The unit test asserts this
  // too; the sweep repeats it because `npm run guard` is the one check that runs
  // over a diff touching nothing else.
  const core = read(join(ROOT, "lib/rag/probeReplayCore.ts"));
  const decl = core.slice(core.indexOf("export const PROBE_LOOKUP"));
  const body = decl.slice(0, decl.indexOf("} as const"));
  if (!/serve:\s*false/.test(body)) {
    fail("lib/rag/probeReplayCore.ts — PROBE_LOOKUP no longer passes serve: false");
  }
  if (!/origin:\s*"probe"/.test(body)) {
    fail('lib/rag/probeReplayCore.ts — PROBE_LOOKUP no longer stamps origin: "probe"');
  }

  // 7c. Nothing anywhere in the probe path banks or judges.
  for (const path of PROBE_FILES) {
    let text: string;
    try {
      text = read(join(ROOT, path));
    } catch {
      fail(`${path} — named in the probe path but the file does not exist`);
      continue;
    }
    const code = codeOnly(text);
    for (const [symbol, why] of Object.entries(FORBIDDEN_IN_PROBE_PATH)) {
      if (new RegExp(`\\b${symbol}\\b`).test(code)) {
        fail(`${path} — references ${symbol}: ${why}`);
      }
    }
  }

  // 7d. RAIL 1 AT RUNTIME, structurally. The lookup's only write is recordShadow,
  // and recordShadow builds its insert from an object literal — so "no probe ever
  // writes a verdict" is true of every code path through the lookup iff that
  // literal has no verdict key. Which is greppable, where the runtime claim would
  // need a live database. (SHADOW_OPTIONAL_COLUMNS only ever DELETES keys from
  // this row, so a column absent here cannot reappear downstream.)
  const cache = codeOnly(read(join(ROOT, "lib/rag/semanticCache.ts")));
  const shadowRow = cache.slice(cache.indexOf("const row: Record<string, unknown> = {"));
  if (/\bverdict\b/.test(shadowRow.slice(0, shadowRow.indexOf("};")))) {
    fail(
      "lib/rag/semanticCache.ts — recordShadow's insert now carries a verdict; probe " +
        "rows must land unjudged (the generator is 80% correct and \u03c4 is a live threshold)",
    );
  }

  // 7e. RAIL 3 AT RUNTIME, structurally. Banking is `insert into semantic_cache`,
  // and it may only appear inside the two functions 7c already bars from the probe
  // path. A third one would be a writer no rail covers.
  const bankers = [...cache.matchAll(/insert into semantic_cache\b/g)].length;
  if (bankers !== 2) {
    fail(
      `lib/rag/semanticCache.ts — ${bankers} writers of semantic_cache, expected 2 ` +
        "(semanticCacheStore, backfillKeyModel); a new one needs adding to " +
        "FORBIDDEN_IN_PROBE_PATH before a probe can reach it",
    );
  }

  // 7f. The single-probe route, checked from both ends — what it must do, and
  // what it must never grow into.
  const route = codeOnly(read(join(ROOT, "app/api/semantic-cache/probe/route.ts")));
  for (const [symbol, why] of Object.entries(REQUIRED_IN_PROBE_ROUTE)) {
    if (!route.includes(symbol)) {
      fail(`app/api/semantic-cache/probe/route.ts — lost ${symbol}: ${why}`);
    }
  }
  for (const [symbol, why] of Object.entries(FORBIDDEN_IN_PROBE_ROUTE)) {
    if (new RegExp(`\\b${symbol}\\b`).test(route)) {
      fail(`app/api/semantic-cache/probe/route.ts — references ${symbol}: ${why}`);
    }
  }

  // 7g. The floor stays the ONLY key the caller can override. replayPairs takes
  // it as a parameter, and it spreads PROBE_LOOKUP.shadow underneath — so a
  // caller can move where rows start being recorded and nothing else. Written as
  // a fresh object literal, that same parameter becomes a way to drop origin:
  // "probe" or serve: false from the outside, which 7a/7b cannot see because the
  // constant they check is still there.
  if (!source.includes("shadow: { ...PROBE_LOOKUP.shadow, floor }")) {
    fail(
      "lib/rag/probeReplay.ts — the shadow options are no longer PROBE_LOOKUP.shadow " +
        "with only `floor` overridden; a literal here lets a caller drop origin/serve",
    );
  }

  console.log(
    `   1 lookup call site on PROBE_LOOKUP; ${PROBE_FILES.length} probe modules free of ` +
      `${Object.keys(FORBIDDEN_IN_PROBE_PATH).length} banking/judging symbols; ` +
      `${bankers} banking sites, none of them reachable; shadow inserts carry no verdict`,
  );
}

sweepExpose();
sweepScopes();
sweepApiGates();
sweepBaselineReads();
sweepTransformersBarrel();
sweepDemoGates();
sweepDemoScope();
sweepProbeReplay();

console.log(
  failures === 0
    ? "\nOK — keys stay wrapped, scopes are entered, every handler is gated, " +
        "baseline rows stay out of live reads, no guest can spend outside the "
        + "demo's frozen scope, the transformers barrel is unimported, and the "
        + "probe path neither serves nor judges."
    : `\nFAILED — ${failures} violation(s).`,
);
if (failures) process.exitCode = 1;
