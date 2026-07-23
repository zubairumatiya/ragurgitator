// Appraise → Semantic caching: shadow-judge calibration. Per vector-space, judge
// recorded would-hit events — a bulk LLM pass, a boundary re-judge, and a human
// Accept/Reject queue — then sweep the labels into a threshold. Judging is
// on-demand (the Run buttons), never inline.
"use client";

import { useCallback, useEffect, useState } from "react";

import { config } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import type {
  CalibrationReport,
  JudgeRunResult,
  ShadowEvent,
  ShadowSpace,
} from "@/lib/rag/semanticCacheCalibration";

import { SC_CHANGED } from "./ThresholdsPanel";

const btn =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
const select =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
const MODELS = config.semanticCache.judgeModelOptions;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function ShadowJudgePanel() {
  const [spaces, setSpaces] = useState<ShadowSpace[]>([]);
  const [space, setSpace] = useState("");
  const [events, setEvents] = useState<ShadowEvent[]>([]);
  const [curve, setCurve] = useState<CalibrationReport | null>(null);
  const [bulkModel, setBulkModel] = useState<string>(config.semanticCache.judgeBulkModel);
  const [boundaryModel, setBoundaryModel] = useState<string>(
    config.semanticCache.judgeBoundaryModel,
  );
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [lastRun, setLastRun] = useState<JudgeRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSpaces = useCallback((keep?: string) => {
    return apiFetch("/api/semantic-cache/shadow")
      .then((r) => r.json())
      .then((d) => {
        const list: ShadowSpace[] = d.spaces ?? [];
        setSpaces(list);
        const next = keep && list.some((s) => s.space === keep) ? keep : list[0]?.space ?? "";
        setSpace(next);
        return next;
      })
      .catch((e) => {
        setError(String(e));
        return "";
      });
  }, []);

  // Only ever sets state from async callbacks (never synchronously in the effect
  // body) so it's safe to call straight from an effect.
  const loadSpaceData = useCallback((s: string) => {
    apiFetch(`/api/semantic-cache/shadow?space=${encodeURIComponent(s)}&filter=unjudged&limit=50`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch((e) => setError(String(e)));
    apiFetch(`/api/semantic-cache/shadow/calibration?space=${encodeURIComponent(s)}`)
      .then((r) => r.json())
      .then((d) => setCurve(d.report ?? null))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);
  useEffect(() => {
    if (space) loadSpaceData(space);
  }, [space, loadSpaceData]);

  const refresh = useCallback(() => {
    loadSpaces(space).then(() => loadSpaceData(space));
  }, [loadSpaces, loadSpaceData, space]);

  const runJudge = (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    setError(null);
    setLastRun(null);
    apiFetch("/api/semantic-cache/shadow/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setLastRun(d.result ?? null);
          refresh();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  const humanVerdict = (id: string, verdict: "accept" | "reject") => {
    setError(null);
    // Optimistically drop it from the unjudged queue.
    setEvents((prev) => prev.filter((e) => e.id !== id));
    apiFetch("/api/semantic-cache/shadow/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "human", id, verdict }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        // Refresh the curve/counts; leave the (already-trimmed) queue as is.
        loadSpaceData(space);
        loadSpaces(space);
      })
      .catch((e) => setError(String(e)));
  };

  const applyCalibrated = () => {
    if (!curve || curve.recommended === null) return;
    setBusy("apply");
    setError(null);
    apiFetch("/api/semantic-cache/thresholds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space,
        threshold: curve.recommended,
        sampleSize: curve.totalJudged,
        notes: `shadow-judge n=${curve.totalJudged} target=${curve.target}`,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else window.dispatchEvent(new Event(SC_CHANGED));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  const current = spaces.find((s) => s.space === space);
  const rec = curve?.recommended ?? null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Shadow judge</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Judge recorded would-hit events — does the stored answer acceptably answer the
          new question? — then sweep the labels for the lowest threshold whose served set
          keeps acceptance ≥ {config.semanticCache.acceptTarget}. Events are judged on
          demand, not as they arrive.
        </p>
      </div>

      {spaces.length === 0 ? (
        <p className="text-xs text-zinc-400">
          No shadow events yet. They accrue as questions are asked against a populated
          cache (any match above the shadow-log floor is recorded).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Space">
              <select value={space} onChange={(e) => setSpace(e.target.value)} className={select}>
                {spaces.map((s) => (
                  <option key={s.space} value={s.space}>
                    {s.space} ({s.judged}/{s.total} judged)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bulk model">
              <select value={bulkModel} onChange={(e) => setBulkModel(e.target.value)} className={select}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Boundary model">
              <select
                value={boundaryModel}
                onChange={(e) => setBoundaryModel(e.target.value)}
                className={select}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btn}
              disabled={busy !== null || !current || current.total === current.judged}
              onClick={() =>
                runJudge("bulk", { mode: "llm", space, model: bulkModel, limit: 100 })
              }
            >
              {busy === "bulk" ? "Judging…" : "Run judge (bulk)"}
            </button>
            <button
              type="button"
              className={btn}
              disabled={busy !== null || rec === null}
              title={
                rec === null
                  ? "Run the bulk pass first to locate the boundary"
                  : `Re-judge sim ∈ [${clamp01(rec - 0.03).toFixed(2)}, ${clamp01(rec + 0.03).toFixed(2)}]`
              }
              onClick={() =>
                rec !== null &&
                runJudge("boundary", {
                  mode: "llm",
                  space,
                  model: boundaryModel,
                  rejudge: true,
                  simMin: clamp01(rec - 0.03),
                  simMax: clamp01(rec + 0.03),
                  limit: 100,
                })
              }
            >
              {busy === "boundary" ? "Refining…" : "Refine boundary"}
            </button>
            {lastRun && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {lastRun.model}: {lastRun.accepted} accept · {lastRun.rejected} reject
                {lastRun.skipped ? ` · ${lastRun.skipped} skipped` : ""}
              </span>
            )}
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          <CalibrationCurve curve={curve} />

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Recommended τ:{" "}
              <span className="font-semibold tabular-nums text-green-700 dark:text-green-400">
                {rec === null ? "—" : rec.toFixed(4)}
              </span>
              {curve && (
                <span className="ml-2 text-xs text-zinc-400">
                  ({curve.totalJudged} judged
                  {curve.overallAcceptRate !== null
                    ? `, ${(curve.overallAcceptRate * 100).toFixed(0)}% accept`
                    : ""}
                  ; needs ≥ {curve.minSamples})
                </span>
              )}
            </span>
            <button
              type="button"
              className={btn}
              disabled={busy !== null || rec === null}
              onClick={applyCalibrated}
            >
              {busy === "apply" ? "Applying…" : `Apply calibrated to ${space}`}
            </button>
          </div>

          <HumanQueue events={events} onVerdict={humanVerdict} />
        </>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

// A compact acceptance-rate-vs-sim sparkline. x = similarity, y = P(accept | sim
// ≥ x); a dashed line marks the target and a vertical rule marks the recommended
// τ. Single-series, monochrome, theme-aware — kept intentionally minimal.
function CalibrationCurve({ curve }: { curve: CalibrationReport | null }) {
  if (!curve || curve.curve.length < 2) {
    return (
      <p className="text-xs text-zinc-400">
        Calibration curve appears once there are at least two judged events.
      </p>
    );
  }
  const W = 640;
  const H = 120;
  const pad = 4;
  const sims = curve.curve.map((p) => p.sim);
  const minSim = Math.min(...sims);
  const maxSim = Math.max(...sims);
  const span = maxSim - minSim || 1;
  const x = (sim: number) => pad + ((sim - minSim) / span) * (W - 2 * pad);
  const y = (rate: number) => pad + (1 - rate) * (H - 2 * pad);
  const points = [...curve.curve]
    .sort((a, b) => a.sim - b.sim)
    .map((p) => `${x(p.sim).toFixed(1)},${y(p.acceptRateAtOrAbove).toFixed(1)}`)
    .join(" ");
  const targetY = y(curve.target);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-28 w-full min-w-[420px] text-zinc-400"
        preserveAspectRatio="none"
      >
        {/* target line */}
        <line
          x1={pad}
          x2={W - pad}
          y1={targetY}
          y2={targetY}
          stroke="currentColor"
          strokeDasharray="4 4"
          strokeWidth={1}
          opacity={0.5}
        />
        {/* recommended τ marker */}
        {curve.recommended !== null && (
          <line
            x1={x(curve.recommended)}
            x2={x(curve.recommended)}
            y1={pad}
            y2={H - pad}
            className="text-green-600 dark:text-green-400"
            stroke="currentColor"
            strokeWidth={1.5}
          />
        )}
        {/* acceptance curve */}
        <polyline
          points={points}
          fill="none"
          className="text-zinc-700 dark:text-zinc-200"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>sim {minSim.toFixed(2)} (more inclusive)</span>
        <span>target {curve.target}</span>
        <span>sim {maxSim.toFixed(2)}</span>
      </div>
    </div>
  );
}

function HumanQueue({
  events,
  onVerdict,
}: {
  events: ShadowEvent[];
  onVerdict: (id: string, verdict: "accept" | "reject") => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Human queue · {events.length} unjudged
      </h3>
      {events.length === 0 && (
        <p className="text-xs text-zinc-400">Nothing unjudged in this space.</p>
      )}
      {events.map((e) => (
        <div
          key={e.id}
          className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">
                new question · sim{" "}
                <span className="tabular-nums text-zinc-600 dark:text-zinc-300">
                  {e.sim.toFixed(4)}
                </span>
              </span>
              <span className="text-zinc-800 dark:text-zinc-200">{e.newQuery}</span>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => onVerdict(e.id, "accept")}
                className="rounded-md border border-green-300 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-900/30"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onVerdict(e.id, "reject")}
                className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
              >
                Reject
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <span className="text-xs text-zinc-400">
              would serve this answer (matched: “{e.matchedQuery}”)
            </span>
            <span className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
              {e.servedAnswer.length > 600 ? `${e.servedAnswer.slice(0, 600)}…` : e.servedAnswer}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
