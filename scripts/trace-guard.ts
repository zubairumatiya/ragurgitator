// WHAT ACTUALLY SHIPS — checked against the traced bundle, not the source.
//
// Nothing in CI could have caught the bug this exists to fence
// (docs/serverless-bundle-fix-plan.md). `next build` succeeded; in CI
// node_modules is complete, so importing a route worked fine. The failure lived
// only in the traced Lambda: @vercel/nft bundled @huggingface/transformers'
// JavaScript but not onnxruntime-node's platform binary, whose path is built at
// runtime, and every route that touched the chunker 500'd in production on a
// missing libonnxruntime.so.1.
//
// So this reads the artifact. Three checks, weakest to most general:
//
//   1. Deny-list — no API route trace may carry onnxruntime, sharp or the
//      transformers dist. The exact regression fence for this bug.
//   2. The general form — a traced package that ships a native addon must have a
//      native artifact traced WITH it. This is the real bug class, and it
//      generalises to the next native dependency anyone adds.
//   3. Bundled, not external — @huggingface/tokenizers must appear in no trace at
//      all, which is what proves it is compiled into the server chunks rather
//      than left for a trace to find at runtime.
//
// A trace records what nft found; scripts/guards.ts sweep 5 checks the source
// form the mistake takes. Both, because either alone leaves a door open: source
// can be clean while a transitive dependency drags the runtime in, and a trace
// can be clean on the day it is checked.
//
//   Usage: npm run guard:trace   (after npm run build; no database, no network)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const TRACE_ROOT = join(ROOT, ".next/server/app");

let failures = 0;
function fail(message: string) {
  failures++;
  console.log(`  ✗ ${message}`);
}

// Packages this deployment must never carry. Matched on the real package path so
// a pnpm directory name — which embeds its peer versions, e.g.
// `voyageai@0.2.1_@huggingface+transformers@4.2.0_onnxruntime-node@1.24.3` — is
// not mistaken for the package itself. That false positive is easy to write and
// makes the check look like it is working when it is not.
const DENIED = /node_modules\/(@huggingface\/transformers|onnxruntime-node|onnxruntime-common|sharp|@img\/sharp[^/]*)\/.+/;

// A file that only exists to be loaded by a native addon loader.
const NATIVE_FILE = /\.node$|\.so(\.\d+)*$|\.dylib$|\.dll$/;

type Trace = { path: string; files: string[] };

function walk(dir: string, match: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out.sort();
}

// nft records paths RELATIVE TO THE .nft.json ITSELF, so every one has to be
// resolved against its own directory before it means anything.
function readTraces(): Trace[] {
  if (!existsSync(TRACE_ROOT)) {
    console.log(`  ✗ ${relative(ROOT, TRACE_ROOT)} not found — run npm run build first`);
    failures++;
    return [];
  }
  return walk(TRACE_ROOT, (p) => p.endsWith(".nft.json")).map((path) => {
    const base = dirname(path);
    const { files } = JSON.parse(readFileSync(path, "utf8")) as { files: string[] };
    return {
      path: relative(ROOT, path),
      files: files.map((f) => relative(ROOT, resolve(base, f))),
    };
  });
}

function isApiRoute(tracePath: string): boolean {
  return tracePath.startsWith(".next/server/app/api/");
}

function checkDenyList(traces: Trace[]) {
  console.log("1. denied packages in API route traces\n");
  let offenders = 0;
  for (const trace of traces) {
    if (!isApiRoute(trace.path)) continue;
    const hits = trace.files.filter((f) => DENIED.test(f));
    if (hits.length === 0) continue;
    offenders++;
    fail(`${trace.path} — carries ${hits.length} denied file(s), e.g. ${hits[0]}`);
  }
  const api = traces.filter((t) => isApiRoute(t.path)).length;
  if (offenders === 0) {
    console.log(`   ${api} API route trace(s), none carrying onnxruntime, sharp or the transformers dist`);
  }
}

// THE GENERAL FORM. For every package a trace reaches, ask the filesystem
// whether that package ships a native addon; if it does, the trace has to carry
// at least one native artifact from it. A package whose JS is traced and whose
// binary is not is precisely the shape of the bug: the module loads, then dies
// looking for a file nobody packaged.
function packageRootOf(file: string): string | null {
  const parts = file.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i - 1] !== "node_modules") continue;
    // Scoped packages take two segments.
    const span = parts[i].startsWith("@") ? 2 : 1;
    if (i + span > parts.length) return null;
    return parts.slice(0, i + span).join("/");
  }
  return null;
}

function shipsNativeAddon(pkg: string): boolean {
  if (!existsSync(pkg)) return false;
  const stack = [pkg];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // A package's own nested node_modules is a different package's business.
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (NATIVE_FILE.test(entry.name) || entry.name === "binding.gyp") return true;
    }
  }
  return false;
}

function checkNativeBinaries(traces: Trace[]) {
  console.log("\n2. traced native packages carry their binary\n");

  // Cache per package: shipsNativeAddon walks a directory tree, and the same
  // packages recur across ~100 traces.
  const native = new Map<string, boolean>();
  const offenders = new Map<string, string>();
  let checked = 0;

  for (const trace of traces) {
    const byPackage = new Map<string, string[]>();
    for (const file of trace.files) {
      const pkg = packageRootOf(file);
      if (!pkg) continue;
      const list = byPackage.get(pkg) ?? [];
      list.push(file);
      byPackage.set(pkg, list);
    }

    for (const [pkg, files] of byPackage) {
      if (!native.has(pkg)) native.set(pkg, shipsNativeAddon(pkg));
      if (!native.get(pkg)) continue;
      checked++;
      if (files.some((f) => NATIVE_FILE.test(f))) continue;
      // Report once per package, naming one trace — the same miss shows up in
      // every route that reaches it, and 100 identical lines hide the answer.
      if (!offenders.has(pkg)) offenders.set(pkg, trace.path);
    }
  }

  for (const [pkg, trace] of offenders) {
    fail(`${pkg} ships a native addon but no binary is traced (e.g. in ${trace})`);
  }
  if (offenders.size === 0) {
    console.log(
      checked === 0
        ? "   no traced package ships a native addon"
        : `   ${checked} traced native package instance(s), all with a binary`,
    );
  }
}

// THE POSITIVE ASSERTION. @huggingface/tokenizers is bundled into the server
// chunks by the compiler, which is why it appears in no trace — nothing has to
// find it on disk at runtime, so nothing can fail to. If it ever turns up in a
// trace, something made it external (serverExternalPackages, an auto-external
// heuristic), and it is one unresolvable path away from the bug this guard is
// named after.
function checkTokenizersBundled(traces: Trace[]) {
  console.log("\n3. @huggingface/tokenizers is bundled, not traced\n");
  const external = traces.filter((t) =>
    t.files.some((f) => /node_modules\/@huggingface\/tokenizers\/.+/.test(f)),
  );
  for (const trace of external.slice(0, 3)) {
    fail(`${trace.path} — @huggingface/tokenizers is traced as external, not compiled in`);
  }
  if (external.length === 0) {
    console.log("   compiled into the server chunks; no trace has to resolve it at runtime");
  }
}

const traces = readTraces();
if (traces.length > 0) {
  checkDenyList(traces);
  checkNativeBinaries(traces);
  checkTokenizersBundled(traces);
}

console.log(
  failures === 0
    ? `\nOK — ${traces.length} traces checked; no native runtime in the Lambda, no native package traced without its binary.`
    : `\nFAILED — ${failures} violation(s).`,
);
if (failures) process.exitCode = 1;
