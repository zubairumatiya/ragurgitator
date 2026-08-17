// Appraise → Semantic caching: shadow-judge calibration. Per vector-space, judge
// recorded would-hit events — a bulk LLM pass, a boundary re-judge, and a human
// Accept/Reject queue — then sweep the labels into a threshold. Judging is
// on-demand, never inline.
//
// Last panel on the page: it needs real would-hit traffic to have accrued and costs
// judge tokens to run, so it refines a threshold the collision floor already put in
// the right neighbourhood.
//
// Judging writes VERDICTS, never a threshold: the swept recommendation is broadcast
// to ApplyThresholdPanel, which owns every threshold write.
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

import { emitRecommendation } from "./events";
import { BTN, NOTE_AMBER, Panel, SELECT } from "./Panel";

// Deliberately does NOT name the target: it's a per-config setting now
// (batch_savings.semanticCache.acceptTarget), so a number baked in here would be
// wrong for any config holding an override. The live value — and whose it is —
// travels on the report and is rendered below the curve.
const ABOUT =
  "Judge recorded would-hit events — does the stored answer acceptably answer " +
  "the new question? — then sweep the labels for the lowest threshold whose " +
  "served set still keeps acceptance at or above the precision target.\n\n" +
  "Events are judged on demand, not as they arrive.";

const pctOf = (n: number) => `${(n * 100).toFixed(1)}%`;

const MODELS = config.semanticCache.judgeModelOptions;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// A curve with no REJECTS in it. Precision is then 100% at every threshold, so the
// sweep's "recommended τ" is just the lowest sim in the sample — a fact about what
// happened to be observed, not a boundary. Real traffic on a small corpus produces
// exactly this: every would-hit is a fair match, and nothing marks where they stop
// being fair.
const degenerate = (r: CalibrationReport) => r.totalJudged > 0 && r.totalAccepts === r.totalJudged;

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
      .then((d) => {
        const report: CalibrationReport | null = d.report ?? null;
        setCurve(report);
        // Offer the swept τ upward. Re-emitted whenever the curve reloads (space
        // switch, fresh verdicts) so the apply box tracks what's on screen; it
        // ignores the value if the user has typed one of their own.
        //
        // NOT offered when the judged set is all accepts. P(accept | sim ≥ τ) is
        // 100% at every τ then, so the sweep returns the LOWEST SIM ANYONE HAS
        // OBSERVED and calls it a recommendation — on this corpus that reads 0.81
        // against a live 0.95, and pre-filling it into the apply box invites a
        // three-fold drop in the serving threshold on the strength of a sample that
        // contains no evidence of where matches fail. A one-class sample cannot
        // locate a boundary; the note below says so instead.
        if (report?.recommended !== null && report !== null && !degenerate(report)) {
          emitRecommendation({
            value: report.recommended,
            space: s,
            origin: "Shadow judge",
            notes: `shadow-judge n=${report.totalJudged} target=${report.target} rows=${report.origin}`,
            sampleSize: report.totalJudged,
          });
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);
  useEffect(() => {
    if (space) loadSpaceData(space);
  }, [space, loadSpaceData]);

  // Reload from the space loadSpaces actually RESOLVED, not the captured one:
  // if the kept space no longer exists it falls back to list[0], and reusing the
  // stale `space` here would then load data for a space we're no longer showing.
  const refresh = useCallback(() => {
    loadSpaces(space).then((next) => next && loadSpaceData(next));
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

  const current = spaces.find((s) => s.space === space);
  const rec = curve?.recommended ?? null;

  return (
    <Panel
      step={3}
      title="Shadow judge"
      about={ABOUT}
      subtitle="Costs judge tokens — refines a floor that's already in the right neighbourhood."
      // The space picker doubles as this panel's scope AND its progress readout
      // ("12/40 judged"), so it belongs on the heading row like the collision
      // floor's config picker.
      action={
        spaces.length > 0 ? (
          <select
            value={space}
            onChange={(e) => setSpace(e.target.value)}
            aria-label="Space"
            className={SELECT}
          >
            {spaces.map((s) => (
              <option key={s.space} value={s.space}>
                {s.space} ({s.judged}/{s.total} judged
                {s.probes > 0 ? `, ${s.probes} probe` : ""})
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {spaces.length === 0 ? (
        <p className="text-xs text-zinc-400">
          No shadow events yet. They accrue as questions are asked against a populated
          cache (any match above the shadow-log floor is recorded).
        </p>
      ) : (
        <>
          {/* The two judging runs and the model each uses, paired: a button next
              to the select that governs it, instead of a row of three unlabelled
              dropdowns above a row of two buttons with no visible link between
              them. */}
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${BTN} min-w-40`}
                disabled={busy !== null || !current || current.total === current.judged}
                onClick={() =>
                  runJudge("bulk", { mode: "llm", space, model: bulkModel, limit: 100 })
                }
              >
                {busy === "bulk" ? "Judging…" : "Run judge (bulk)"}
              </button>
              <span className="text-xs text-zinc-400">with</span>
              <select
                value={bulkModel}
                onChange={(e) => setBulkModel(e.target.value)}
                aria-label="Bulk model"
                className={SELECT}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${BTN} min-w-40`}
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
              <span className="text-xs text-zinc-400">with</span>
              <select
                value={boundaryModel}
                onChange={(e) => setBoundaryModel(e.target.value)}
                aria-label="Boundary model"
                className={SELECT}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {lastRun && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {lastRun.model}: {lastRun.accepted} accept · {lastRun.rejected} reject
                {lastRun.skipped ? ` · ${lastRun.skipped} skipped` : ""}
              </p>
            )}
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          {/* The curve and the number it produces, in one block: the τ readout
              was floating as a bare sentence under the chart, reading as a
              caption rather than as the panel's output. */}
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="flex items-baseline gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Recommended τ</span>
                <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {rec === null ? "—" : rec.toFixed(4)}
                </span>
              </span>
              {curve && (
                <span className="text-xs text-zinc-400">
                  {curve.totalJudged} judged
                  {curve.overallAcceptRate !== null
                    ? `, ${(curve.overallAcceptRate * 100).toFixed(0)}% accept`
                    : ""}
                  ; needs ≥ {curve.minSamples}
                  {/* A τ swept over synthetic near-misses is a worst-case bound, not
                      a setting — so when probe rows exist, say that they're out and
                      how many, rather than letting "n judged" imply real traffic. */}
                  {curve.excludedByOrigin > 0 && (
                    <> · real traffic only ({curve.excludedByOrigin} probe rows excluded)</>
                  )}
                </span>
              )}
            </div>

            <CalibrationCurve curve={curve} />

            {/* WHY a τ is shown but not offered. Without this the panel prints a
                number and silently declines to forward it, which reads as a bug. */}
            {curve && rec !== null && degenerate(curve) && (
              <p className={NOTE_AMBER}>
                Not offered for applying: all {curve.totalJudged} judged events were
                accepted, so precision is 100% at every threshold and the sweep returns
                the lowest similarity in the sample rather than a boundary. Nothing here
                shows where matches start failing
                {curve.excludedByOrigin > 0 ? (
                  <>
                    {" "}
                    — the {curve.excludedByOrigin} excluded probe rows do, but a curve
                    built from engineered near-misses is a worst-case bound, not this
                    account&apos;s traffic
                  </>
                ) : null}
                . Keep the current threshold until real rejects appear.
              </p>
            )}

            {/* Points UP to the apply box, in the Collision floor panel's footer
                at the top of the page. */}
            {rec !== null && !degenerate(curve!) && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Sent to the <strong className="font-medium">Set threshold</strong> box at the
                bottom of the Collision floor panel — nothing is live until you apply it
                there.
              </p>
            )}
          </div>

          {/* WHY there's no τ. Without this the panel shows a dash and the target
              line on the chart, leaving "is my data too small or my target too
              strict?" to be worked out by hand — and those have opposite fixes. */}
          {curve && rec === null && curve.attainability.blocker !== "no-events" && (
            <p className={NOTE_AMBER}>
              {curve.attainability.blocker === "below-min-samples" ? (
                <>
                  No τ yet: {curve.totalJudged} judged never fills a serve set of{" "}
                  {curve.minSamples}, so {pctOf(curve.target)} was never tested. Judge more
                  events.
                </>
              ) : (
                <>
                  No τ at {pctOf(curve.target)}: the closest serve set held{" "}
                  <span className="tabular-nums">{curve.attainability.bestRateAt!.n}</span> events
                  at <span className="tabular-nums">{pctOf(curve.attainability.bestRate!)}</span>{" "}
                  ({curve.attainability.rejectsInBest} rejected).
                  {curve.attainability.requiredN !== null ? (
                    <>
                      {" "}
                      Clearing {pctOf(curve.target)} with {curve.attainability.rejectsInBest}{" "}
                      rejected needs{" "}
                      <span className="tabular-nums">{curve.attainability.requiredN}</span> events
                      at or above τ — judge more, or lower the target for{" "}
                      <span className="font-mono">{curve.targetSource.configLabel}</span> in
                      Settings → Savings.
                    </>
                  ) : (
                    <>
                      {" "}
                      At {pctOf(curve.target)} no serve set size forgives a single reject, so only
                      a perfectly clean prefix yields a τ. Lower the target for{" "}
                      <span className="font-mono">{curve.targetSource.configLabel}</span> in
                      Settings → Savings.
                    </>
                  )}
                </>
              )}
            </p>
          )}

          <HumanQueue events={events} onVerdict={humanVerdict} />
        </>
      )}
    </Panel>
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
      {/* Scrolls rather than growing: the queue fetches up to 50 events and each
          card carries 600 characters of answer, so an unjudged space used to run
          the page thousands of pixels past the panels below it. */}
      <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1 empty:hidden">
        {events.map((e) => (
        <div
          key={e.id}
          className="flex shrink-0 flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
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
    </div>
  );
}
