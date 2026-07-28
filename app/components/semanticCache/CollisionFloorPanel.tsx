// Appraise → Semantic caching: collision-floor calibration. Pick a config, compute
// the eval-bank collision floor for its vector-space (POST /collision-floor,
// config-scoped via ?configId=), and review the safe band. Pure arithmetic
// server-side — no LLM calls, available immediately.
//
// First panel on the page: it's free (no LLM calls) and available as soon as a
// config has labeled questions, so it's where a threshold starts.
//
// The last report per config is SAVED (migration 0037), so this panel loads it on
// mount and whenever the config picker changes instead of making you re-run a
// sweep whose inputs haven't moved. A saved report is displayed and broadcast
// exactly like a fresh one — the only difference is the "Computed …" stamp and,
// when the config's labeled-question count has moved since, a stale hint.
//
// READ-ONLY as far as thresholds go: this panel writes nothing that is served
// from (the saved report is a display cache). The recommendation is broadcast to
// ApplyThresholdPanel, which rides this panel's own heading row (the `action`
// slot) and owns every write.
"use client";

import { useEffect, useState, type ReactNode } from "react";

import { InfoDot } from "@/app/components/InfoDot";
import { Tooltip } from "@/app/components/Tooltip";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { CollisionFloorReport } from "@/lib/rag/semanticCacheCalibration";

import { emitRecommendation } from "./events";

const ABOUT =
  "From a config's labeled eval questions: the highest cosine between two " +
  "questions with DIFFERENT ground-truth chunks is the floor — the closest two " +
  "genuinely-different questions ever land. The threshold must sit above it.\n\n" +
  "The recommendation adds a small margin and stays below the nearest " +
  "same-answer pair, so it catches paraphrases with no false hit on the eval bank.";

const btn =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));
// Date AND time: a floor can be recomputed several times in one sitting, so the
// day alone wouldn't tell you which run you're looking at (cf. fmtDate in
// ThresholdsPanel, where calibrations are days apart).
const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

// What both verbs return: the report plus the stamp and the live labeled-question
// count the staleness hint compares against.
type FloorResponse = {
  report?: CollisionFloorReport | null;
  computedAt?: string | null;
  questionsNow?: number | null;
  error?: string;
};

// Offer the recommendation upward; the apply panel decides what to do with it.
// Shared by the fresh-compute and load-saved paths so a restored report carries
// exactly the same provenance into semantic_cache_thresholds.notes.
function offer(report: CollisionFloorReport): void {
  if (report.recommended === null) return;
  emitRecommendation({
    value: report.recommended,
    space: report.space,
    origin: "Collision floor",
    notes: `collision-floor (${report.embeddingModel}) floor=${num(report.floor)}`,
    sampleSize: report.distinctPairs + report.sameAnswerPairs,
  });
}

// A report (fresh or restored) STAMPED with the config it describes: when it was
// computed and how many labeled questions that config has now travel with it, so
// a slow response can never paint one config's floor under another's name.
type Loaded = {
  configId: string;
  report: CollisionFloorReport;
  computedAt: string | null;
  questionsNow: number | null;
};

// `action` is the apply control, rendered on this section's heading row: the
// recommendation computed here is what you'd apply, so the control sits with it
// and costs no vertical space.
export function CollisionFloorPanel({ action }: { action?: ReactNode }) {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [configId, setConfigId] = useState("");
  // Stamped rather than cleared on switch: nothing is set synchronously in an
  // effect (which would cascade renders), and rendering simply ignores a report
  // belonging to a config that is no longer selected.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ configId: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/configs")
      .then((r) => r.json())
      .then((d) => {
        const all: ConfigSummary[] = [...(d.open ?? []), ...(d.closed ?? [])];
        setConfigs(all);
        if (all[0]) setConfigId(all[0].id);
      })
      .catch(() => setConfigs([]));
  }, []);

  // Restore the saved report on mount and on every config switch, so coming back
  // to this page shows the last floor instead of an empty panel. `live` drops a
  // response that lands after the picker has moved on.
  useEffect(() => {
    if (!configId) return;
    let live = true;
    apiFetch(`/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}`)
      .then((r) => r.json())
      .then((d: FloorResponse) => {
        if (!live) return;
        if (d.error) return setError({ configId, message: d.error });
        // No saved report is the normal empty state (nothing computed yet, or
        // migration 0037 not applied) — not an error, just an empty panel.
        if (!d.report) return;
        setLoaded({
          configId,
          report: d.report,
          computedAt: d.computedAt ?? null,
          questionsNow: d.questionsNow ?? null,
        });
        offer(d.report);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [configId]);

  const compute = () => {
    if (!configId) return;
    setBusy(true);
    setError(null);
    setLoaded(null);
    apiFetch(`/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}`, {
      method: "POST",
    })
      .then((r) => r.json())
      .then((d: FloorResponse) => {
        if (d.error) return setError({ configId, message: d.error });
        if (!d.report) return;
        setLoaded({
          configId,
          report: d.report,
          computedAt: d.computedAt ?? null,
          questionsNow: d.questionsNow ?? null,
        });
        offer(d.report);
      })
      .catch((e) => setError({ configId, message: String(e) }))
      .finally(() => setBusy(false));
  };

  // Only ever show state belonging to the config currently in the picker.
  const view = loaded?.configId === configId ? loaded : null;
  const report = view?.report ?? null;
  const errorMessage = error?.configId === configId ? error.message : null;

  // The bank moved under the saved report: its pair counts describe a set of
  // questions the config no longer has. The numbers stay on screen (they're
  // still the last real measurement) with a nudge to re-run. Unknown count →
  // no hint, never a false alarm.
  const stale =
    view !== null &&
    view.questionsNow !== null &&
    view.questionsNow !== view.report.questionsTotal;

  return (
    // Unboxed, with a rule underneath instead: the section reads as part of the
    // page rather than a card, and the border is all the separation it needs
    // from the Thresholds table that follows.
    <section className="flex flex-col gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Collision floor
          <InfoDot text={ABOUT} />
        </h2>
        {action}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={configId}
          onChange={(e) => setConfigId(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        >
          {configs.length === 0 && <option value="">No configs</option>}
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.baseModel}
            </option>
          ))}
        </select>
        <button type="button" className={btn} onClick={compute} disabled={busy || !configId}>
          {busy ? "Computing…" : report ? "Recompute" : "Compute"}
        </button>

        {view?.computedAt && (
          <span className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Computed {fmtWhen(view.computedAt)}</span>
            {stale && (
              <Tooltip
                align="left"
                text={
                  `This config had ${view.report.questionsTotal} labeled question` +
                  `${view.report.questionsTotal === 1 ? "" : "s"} when the floor was ` +
                  `computed and has ${view.questionsNow} now. The pairs below were ` +
                  "measured against the old bank — recompute to calibrate against " +
                  "the questions the config actually has."
                }
              >
                <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
                  ↻ eval bank changed
                </span>
              </Tooltip>
            )}
          </span>
        )}
      </div>

      {errorMessage && <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>}

      {report && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <Stat label="Space" value={report.space} mono />
            <Stat label="Collision floor" value={num(report.floor)} />
            <Stat label="Nearest same-answer" value={num(report.sameAnswerMin)} />
            <Stat
              label="Recommended"
              value={num(report.recommended)}
              accent={report.recommended !== null}
            />
            <Stat label="Distinct pairs" value={String(report.distinctPairs)} />
            <Stat label="Same-answer pairs" value={String(report.sameAnswerPairs)} />
            <Stat
              label="Questions used"
              value={`${report.questionsUsed}/${report.questionsTotal}`}
            />
            <Stat label="Same-answer median" value={num(report.sameAnswerMedian)} />
          </div>

          {report.overlap && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              No fully-safe band: a distinct-question pair is closer than a same-answer
              pair. The recommendation stays just above the floor (catches fewer
              paraphrases) to keep zero false hits on the eval bank.
            </p>
          )}
          {report.recommended === null && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Not enough labeled questions with cached embeddings to calibrate this
              space — score more eval questions on this config first.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-zinc-400">{label}</span>
      <span
        className={`tabular-nums ${mono ? "font-mono text-xs" : ""} ${
          accent
            ? "font-semibold text-green-700 dark:text-green-400"
            : "text-zinc-800 dark:text-zinc-200"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
