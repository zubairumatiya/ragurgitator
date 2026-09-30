// The app's one logger: one JSON object per line on stdout, with the request's
// identity stamped on every line from an AsyncLocalStorage, so a runtime log full of
// interleaved requests can be filtered back into one by `requestId`.
//
// Hand-rolled, no pino: its transports run on worker threads, the wrong shape for a
// function that dies at 300 s. See docs/obs-2-structured-logging-plan.md §0.
//
// The context is entered where the ids are first known — lib/http/configScope.ts
// (requestId, route, configId), lib/auth/userScope.ts (userId), lib/jobs/runner.ts
// (jobId) — and each entry MERGES into the one it is nested in. It holds ids only,
// which is why ndjson.ts lets its producer inherit it rather than resetting it.
//
// Never put a provider key, a request body or a document's text in `fields`.
import { AsyncLocalStorage } from "node:async_hooks";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export type LogContext = {
  requestId?: string;
  // Absent under withRequestUser, which has no Request to read it from.
  route?: string;
  userId?: string;
  guest?: boolean;
  configId?: string;
  jobId?: string;
};

const store = new AsyncLocalStorage<LogContext>();

function newRequestId(): string {
  return Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
}

// Run `fn` with `ctx` merged over the current context. A scope always has a
// requestId: the one passed, the enclosing one, or a fresh 8-hex id — so a job slice
// or a script still gets lines that join.
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { ...store.getStore(), ...ctx };
  merged.requestId ??= newRequestId();
  return store.run(merged, fn);
}

// The current context, possibly empty.
export function logContext(): LogContext {
  return store.getStore() ?? {};
}

// For facts learned mid-request that no scope boundary is waiting on (guest status
// is read lazily, and memoised, from deep inside the request). Mutates the
// innermost scope in place, so it reaches every later line of that scope.
export function annotateLogContext(ctx: LogContext): void {
  const current = store.getStore();
  if (current) Object.assign(current, ctx);
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function stringify(line: Record<string, unknown>): string {
  try {
    return JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    // A circular field must not take the request down with it.
    return JSON.stringify({ t: line.t, level: line.level, msg: line.msg, logError: "unserializable fields" });
  }
}

type Sink = (level: Level, line: string) => void;

// Vercel reads the level off the stream, so warn and error go to stderr.
const consoleSink: Sink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

// Under NODE_ENV=test lines are kept rather than printed; the cap stops a long run
// from growing it without bound.
const testBuffer: string[] = [];
const testSink: Sink = (_level, line) => {
  testBuffer.push(line);
  if (testBuffer.length > 1000) testBuffer.shift();
};

let captured: string[] | null = null;

function emit(level: Level, msg: string, fields?: Fields): void {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const t = new Date().toISOString();
  const line: Record<string, unknown> = { t, level, msg };
  Object.assign(line, store.getStore());
  if (fields) for (const [k, v] of Object.entries(fields)) line[k] = serialize(v);
  // Reassigned after the spread so a field can never overwrite them.
  line.t = t;
  line.level = level;
  line.msg = msg;
  const text = stringify(line);
  if (captured) captured.push(text);
  else (process.env.NODE_ENV === "test" ? testSink : consoleSink)(level, text);
}

type Logger = Record<Level, (msg: string, fields?: Fields) => void> & {
  // Test door: every line from now on goes into the returned array instead of the
  // sink, until `stop()`.
  __capture(): { lines: string[]; stop(): void };
};

export const log: Logger = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
  __capture() {
    const lines: string[] = [];
    captured = lines;
    return {
      lines,
      stop() {
        if (captured === lines) captured = null;
      },
    };
  },
};
