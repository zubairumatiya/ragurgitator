// PROVIDER KEY USAGE LEDGER (0072) — one row per call this app made with a
// user's key, and the read side /usage renders.
//
// WHAT IT IS FOR. Under strict BYOK the plaintext key must exist in this
// process's memory to be sent to a provider, so encryption at rest cannot defend
// against whoever operates the server. This is the honest follow-on: detection
// where prevention is impossible. It catches a leaked key spent by a third
// party, a dependency exfiltrating credentials, a runaway loop in our own code,
// and "why is my bill $40". It does not catch us — a malicious operator would
// not write the row. Its value is as ONE HALF OF A COMPARISON against the
// provider's own dashboard, which is what /usage's copy has to say.
//
// NOT IN savingsStore.ts, though both are cost telemetry. That module is keyed by
// config and silently drops any write made outside a config scope
// (`if (!configId) return;`). A ledger that quietly discarded the calls made
// outside a config scope would be worse than no ledger, because it would look
// complete. Different owner (user, not config), different grain (events, not
// totals), different retention (pruned, not permanent).
//
// BEST-EFFORT, like every other recorder here: a missing table (42P01) makes
// writes no-op so the app runs identically before the migration is applied, and
// write errors are swallowed so telemetry never fails an answer. The one thing
// it must not do is swallow the CALL's error — trackKeyUsage records the failure
// and rethrows.
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { PROVIDER_META, type ProviderId } from "@/lib/auth/providerKeys";
import { activeUserId } from "@/lib/auth/userScope";
import { isolated, sql } from "@/lib/db";
import { detached } from "@/lib/detached";
import { keyLastFourFor } from "@/lib/llm/client";
import { activeConfigOrNull } from "@/lib/rag/activeConfig";
import { SURFACE_LABELS, type Surface } from "@/lib/rag/pricing";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// What kind of call this was. Distinguished from `surface` (which says what the
// app was doing) because a batch job's control-plane calls — submit, poll, fetch,
// cancel — spend nothing and would otherwise be indistinguishable from the work
// they schedule. In a compromise the control-plane rows are the interesting ones:
// they are what an attacker enumerating an account would produce.
export type KeyUsageKind =
  | "message"
  | "embed"
  | "batch_submit"
  | "batch_poll"
  | "batch_fetch"
  | "batch_cancel";

// pricing.Surface plus "batch". NOT added to Surface itself: that union is the
// key of spend_totals, where a "batch" row would be a lie — batch spend is
// already recorded against the surface whose work it is doing. Here the extra
// member is honest, because the control-plane calls genuinely belong to no
// surface.
export type KeyUsageSurface = Surface | "batch";

export function keyUsageSurfaceLabel(surface: string): string {
  if (surface === "batch") return "Batch control";
  return SURFACE_LABELS[surface as Surface] ?? surface;
}

export const KIND_LABELS: Record<KeyUsageKind, string> = {
  message: "Message",
  embed: "Embed",
  batch_submit: "Batch submit",
  batch_poll: "Batch poll",
  batch_fetch: "Batch fetch",
  batch_cancel: "Batch cancel",
};

// What a call site knows BEFORE it makes the call — everything that is still
// true if the provider rejects it.
export type KeyUsageMeta = {
  provider: ProviderId;
  model: string; // "" for control-plane calls that carry no model
  surface: KeyUsageSurface;
  kind: KeyUsageKind;
};

// What it knows only after a successful one.
export type KeyUsageAmounts = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const NO_AMOUNTS: KeyUsageAmounts = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

// Exported for lib/jobs/runner.ts's drain only — see flushKeyUsageEvents.
export type KeyUsageEvent = KeyUsageMeta &
  KeyUsageAmounts & {
    userId: string;
    configId: string | null;
    keyLastFour: string;
    ok: boolean;
    errorCode: string | null;
  };

// --- write side --------------------------------------------------------------

// COALESCING BUFFER. A background job slice makes hundreds of provider calls, and
// lib/jobs/runner.ts does not install a detached queue (a job has no response to
// flush after), so an unbuffered recorder would run one synchronous INSERT per
// call inside the work transaction — on the highest-volume path in the app. With
// a buffer installed, a slice costs one multi-row INSERT.
//
// Requests use the same buffer for the same reason at a smaller scale: a chat
// answer's 3–5 calls become one statement instead of five.
const buffer = new AsyncLocalStorage<KeyUsageEvent[]>();

// Collect this scope's rows and write them as ONE statement when it ends.
//
// `drain` decides WHERE that write happens, and the two callers need different
// answers. Requests take the default: `detached()` queues the insert and Next's
// after() runs it once the response is out, so the request path pays only a queue
// push. The job runner passes its own drain to run the insert in a FRESH
// transaction, outside the work transaction — otherwise a slice that throws would
// roll its own ledger rows back, losing exactly the burst of failures this table
// exists to show.
export async function withKeyUsageBuffer<T>(
  fn: () => Promise<T>,
  drain: (events: KeyUsageEvent[]) => Promise<void> = (events) =>
    detached(() => flushKeyUsageEvents(events)),
): Promise<T> {
  // Reentrant: a nested scope appends to the buffer already installed rather than
  // draining its share early.
  if (buffer.getStore()) return fn();
  const events: KeyUsageEvent[] = [];
  try {
    return await buffer.run(events, fn);
  } finally {
    // splice, not the array itself: whatever `drain` does with it happens later,
    // and the buffer must not be able to gain a row after it has been handed off.
    if (events.length > 0) {
      const batch = events.splice(0);
      try {
        await drain(batch);
      } catch (err) {
        console.warn(`[keyusage] drain failed: ${(err as Error).message}`);
      }
    }
  }
}

// Run `call`, recording it either way, and rethrow whatever it threw.
//
// THE INVERSION FROM recordSpend: that only ever sees successes, because a
// rejected call spends nothing. Here a rejection is the point — a burst of 401s
// is the single most legible signature of a key being spent by someone else.
export async function trackKeyUsage<T>(
  meta: KeyUsageMeta,
  call: () => Promise<T>,
  usageOf?: (result: T) => KeyUsageAmounts,
): Promise<T> {
  try {
    const result = await call();
    // A throwing usageOf must not turn a successful provider call into a failed
    // one: the response is already paid for and already in hand.
    let amounts = NO_AMOUNTS;
    try {
      amounts = usageOf?.(result) ?? NO_AMOUNTS;
    } catch (err) {
      console.warn(`[keyusage] usage read failed: ${(err as Error).message}`);
    }
    await recordKeyUsage(meta, true, null, amounts);
    return result;
  } catch (err) {
    await recordKeyUsage(meta, false, errorCodeOf(err), NO_AMOUNTS);
    throw err;
  }
}

async function recordKeyUsage(
  meta: KeyUsageMeta,
  ok: boolean,
  errorCode: string | null,
  amounts: KeyUsageAmounts,
): Promise<void> {
  let event: KeyUsageEvent;
  try {
    event = {
      ...meta,
      ...amounts,
      userId: activeUserId(),
      configId: activeConfigOrNull()?.id ?? null,
      keyLastFour: keyLastFourFor(activeUserId(), meta.provider),
      ok,
      errorCode,
    };
  } catch {
    // No user scope. Nothing here can be attributed, and the table's user_id is
    // NOT NULL, so there is no half-row worth writing. Reachable only from a
    // script, where the ledger is not the point.
    return;
  }

  const pending = buffer.getStore();
  if (pending) {
    pending.push(event);
    return;
  }
  // Unbuffered: inside a request `detached` still defers this past the response;
  // outside one it runs inline, which is the correct fallback for a script.
  await detached(() => flushKeyUsageEvents([event]));
}

// One multi-row INSERT — the buffer's drain. `sql(rows, ...cols)` is postgres.js's
// bulk form.
//
// Exported ONLY because lib/jobs/runner.ts has to supply its own drain: a job
// slice has no response to flush after, so it puts this write in a fresh
// transaction of its own rather than in the work transaction. Nothing else should
// call it — trackKeyUsage is the write path, and a caller reaching past it would
// be recording a call the ledger never saw made.
export async function flushKeyUsageEvents(events: KeyUsageEvent[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => ({
    user_id: e.userId,
    config_id: e.configId,
    provider: e.provider,
    model: e.model,
    surface: e.surface,
    kind: e.kind,
    key_last_four: e.keyLastFour,
    input_tokens: Math.round(e.inputTokens),
    output_tokens: Math.round(e.outputTokens),
    cost_usd: e.costUsd,
    ok: e.ok,
    error_code: e.errorCode,
  }));
  try {
    await isolated(
      () => sql`
        insert into provider_key_usage ${sql(
          rows,
          "user_id",
          "config_id",
          "provider",
          "model",
          "surface",
          "kind",
          "key_last_four",
          "input_tokens",
          "output_tokens",
          "cost_usd",
          "ok",
          "error_code",
        )}
      `,
    );
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[keyusage] insert of ${events.length} failed: ${(err as Error).message}`);
  }
}

// What went wrong, in a form worth grouping by — an HTTP status where the SDKs
// give one, otherwise a short tag. Deliberately NOT the provider's message: the
// column exists so "17 × 401" is visible at a glance, and free text does not
// aggregate. The full message is already in the app log.
function errorCodeOf(err: unknown): string {
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  if (typeof e?.status === "number") return String(e.status);
  if (typeof e?.code === "string" && e.code) return e.code;
  // The Voyage batch path is raw fetch, so its status only exists in the message
  // ("Voyage POST /batches → 401: …"). One narrow parse beats losing the status
  // on the one provider whose control plane has no SDK.
  const match = /→ (\d{3})/.exec(e?.message ?? "");
  if (match) return match[1];
  return e?.name ?? "error";
}

// --- read side ---------------------------------------------------------------

export type KeyUsageTotal = {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type KeyUsageDay = {
  day: string; // YYYY-MM-DD, UTC
  calls: number;
  failures: number;
  costUsd: number;
};

// The window the three queries actually ran over, as UTC dates. The daily chart
// needs these to draw a fixed 30-day axis: it cannot derive them from `days`,
// because `days` only contains the days that HAVE calls, and it must not derive
// them from Date.now() during render (react-hooks/purity). Sent from here, where
// the same `since` that bounded the SQL is already in hand.
export type KeyUsageWindow = {
  start: string; // YYYY-MM-DD, UTC — inclusive
  end: string; // YYYY-MM-DD, UTC — inclusive
};

export type KeyUsageRow = {
  id: string;
  at: number;
  provider: ProviderId;
  providerLabel: string;
  model: string;
  surface: string;
  surfaceLabel: string;
  kind: string;
  kindLabel: string;
  keyLastFour: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  errorCode: string | null;
  configLabel: string | null; // null once the config is deleted (0072 set null)
};

export type KeyUsageReport = {
  windowDays: number;
  window: KeyUsageWindow;
  totals: KeyUsageTotal[];
  days: KeyUsageDay[];
  rows: KeyUsageRow[];
  totalCalls: number;
  totalFailures: number;
  totalCostUsd: number;
  rowsShown: number;
  hasData: boolean;
};

// How far back /usage looks, and how many raw rows it renders. The window is a
// month because that is the unit a provider bills in, and reconciliation happens
// against a bill.
const WINDOW_DAYS = 30;
const ROW_LIMIT = 500;

// A function, not a const. The window dates have to be computed per call — a
// module-level literal would pin them to whenever the process booted.
const emptyReport = (): KeyUsageReport => ({
  windowDays: WINDOW_DAYS,
  window: windowFor(new Date()),
  totals: [],
  days: [],
  rows: [],
  totalCalls: 0,
  totalFailures: 0,
  totalCostUsd: 0,
  rowsShown: 0,
  hasData: false,
});

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

// Inclusive of both ends: `since` is the same instant the queries filter on, and
// `now` is today, so the axis covers exactly the days a call could land in.
function windowFor(now: Date): KeyUsageWindow {
  return {
    start: utcDay(new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)),
    end: utcDay(now),
  };
}

const providerLabel = (p: ProviderId): string => PROVIDER_META[p]?.label ?? p;

// Three reads over the same window: the provider × model rollup, the daily strip,
// and the tail of raw rows. Separate statements rather than one over-clever
// query — they are three different grains, the table is pruned, and the index
// (user_id, created_at desc) serves all three.
export async function getKeyUsageReport(): Promise<KeyUsageReport> {
  try {
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const userId = activeUserId();

    const totals = await sql<
      {
        provider: ProviderId;
        model: string;
        calls: string;
        failures: string;
        input_tokens: string;
        output_tokens: string;
        cost_usd: string;
      }[]
    >`
      select provider,
             model,
             count(*)                            as calls,
             count(*) filter (where not ok)      as failures,
             coalesce(sum(input_tokens), 0)      as input_tokens,
             coalesce(sum(output_tokens), 0)     as output_tokens,
             coalesce(sum(cost_usd), 0)          as cost_usd
        from provider_key_usage
       where user_id = ${userId} and created_at >= ${since}
       group by provider, model
       order by sum(cost_usd) desc, count(*) desc
    `;

    const days = await sql<
      { day: Date; calls: string; failures: string; cost_usd: string }[]
    >`
      select date_trunc('day', created_at at time zone 'UTC') as day,
             count(*)                       as calls,
             count(*) filter (where not ok) as failures,
             coalesce(sum(cost_usd), 0)     as cost_usd
        from provider_key_usage
       where user_id = ${userId} and created_at >= ${since}
       group by 1
       order by 1
    `;

    const rows = await sql<
      {
        id: string;
        created_at: Date;
        provider: ProviderId;
        model: string;
        surface: string;
        kind: string;
        key_last_four: string;
        input_tokens: string;
        output_tokens: string;
        cost_usd: string;
        ok: boolean;
        error_code: string | null;
        name: string | null;
        base_model: string | null;
        chunk_size: number | null;
        chunk_overlap: number | null;
      }[]
    >`
      select u.id,
             u.created_at,
             u.provider,
             u.model,
             u.surface,
             u.kind,
             u.key_last_four,
             u.input_tokens,
             u.output_tokens,
             u.cost_usd,
             u.ok,
             u.error_code,
             c.name,
             c.base_model,
             c.chunk_size,
             c.chunk_overlap
        from provider_key_usage u
        left join configs c on c.id = u.config_id
       where u.user_id = ${userId} and u.created_at >= ${since}
       order by u.created_at desc
       limit ${ROW_LIMIT}
    `;

    // Opportunistic, and deliberately AFTER the reads: a prune that fails must not
    // cost the page its data, and one that succeeds must not delete rows this
    // render was about to show.
    //
    // Through detached() rather than a bare `void`, which lib/db.ts is explicit
    // about: a write started with `void` inside a request scope issues its SQL
    // after that transaction has committed, on a pooled connection with no
    // app.user_id — every RLS policy denies, and it can abort whichever user's
    // transaction has since been handed that connection.
    await detached(() => pruneKeyUsage());

    const report: KeyUsageReport = {
      windowDays: WINDOW_DAYS,
      window: windowFor(now),
      totals: totals.map((t) => ({
        provider: t.provider,
        providerLabel: providerLabel(t.provider),
        model: t.model,
        calls: Number(t.calls),
        failures: Number(t.failures),
        inputTokens: Number(t.input_tokens),
        outputTokens: Number(t.output_tokens),
        costUsd: Number(t.cost_usd),
      })),
      days: days.map((d) => ({
        day: d.day.toISOString().slice(0, 10),
        calls: Number(d.calls),
        failures: Number(d.failures),
        costUsd: Number(d.cost_usd),
      })),
      rows: rows.map((r) => ({
        id: String(r.id),
        at: r.created_at.getTime(),
        provider: r.provider,
        providerLabel: providerLabel(r.provider),
        model: r.model,
        surface: r.surface,
        surfaceLabel: keyUsageSurfaceLabel(r.surface),
        kind: r.kind,
        kindLabel: KIND_LABELS[r.kind as KeyUsageKind] ?? r.kind,
        keyLastFour: r.key_last_four,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        costUsd: Number(r.cost_usd),
        ok: r.ok,
        errorCode: r.error_code,
        // Null base_model ⇒ the config is gone (0072's set null), which the UI
        // reports as such rather than manufacturing a label out of nulls. Same
        // shape as listCacheEntries.
        configLabel:
          r.base_model === null
            ? null
            : (r.name ?? `${r.base_model} · ${r.chunk_size}/${r.chunk_overlap}`),
      })),
      totalCalls: 0,
      totalFailures: 0,
      totalCostUsd: 0,
      rowsShown: rows.length,
      hasData: totals.length > 0,
    };

    // Totals from the ROLLUP, not from `rows`: rows are capped at ROW_LIMIT and a
    // headline figure computed from a truncated list would quietly under-report.
    for (const t of report.totals) {
      report.totalCalls += t.calls;
      report.totalFailures += t.failures;
      report.totalCostUsd += t.costUsd;
    }
    return report;
  } catch (err) {
    if (isMissingTable(err)) return emptyReport();
    throw err;
  }
}

// --- retention ---------------------------------------------------------------

// Two bounds, because either alone has a hole. Age alone never fires for a user
// who stops using the app; a volume cap alone keeps a dormant account's rows
// forever. Together they bound both the worst case and the boring one, without a
// scheduler — cron is infra this app does not otherwise need.
const MAX_AGE_DAYS = 90; // two monthly bills' worth of reconciliation
const MAX_ROWS_PER_USER = 50_000; // ~10MB with the index

// Called from the /usage read and from background-job completion, so a heavy user
// prunes without ever opening the page. Never throws: a failed prune is a table
// that stays larger than intended, which is not worth failing anything over.
export async function pruneKeyUsage(): Promise<void> {
  try {
    const userId = activeUserId();
    await isolated(
      () => sql`
        delete from provider_key_usage
         where user_id = ${userId}
           and created_at < now() - ${`${MAX_AGE_DAYS} days`}::interval
      `,
    );
    // The volume cap, oldest first — the same shape semanticCache's pruneByVolume
    // uses: rank the rows to KEEP and delete past the offset.
    await isolated(
      () => sql`
        delete from provider_key_usage
         where id in (
           select id from provider_key_usage
            where user_id = ${userId}
            order by created_at desc
           offset ${MAX_ROWS_PER_USER}
         )
      `,
    );
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[keyusage] prune failed: ${(err as Error).message}`);
  }
}
