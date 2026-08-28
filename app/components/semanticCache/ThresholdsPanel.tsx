// Appraise → Semantic caching: the per-space threshold + stats table. Read-only.
// Reads GET /api/semantic-cache/thresholds and re-pulls whenever the apply panel
// writes a threshold (the SC_CHANGED window event).
"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/http/client";
import type { ThresholdReport } from "@/lib/rag/semanticCacheCalibration";

import { SC_CHANGED } from "./events";
import { Panel, TABLE_HEAD, TABLE_WRAP } from "./Panel";

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

const ABOUT =
  "The cosine threshold each embedding space is calibrated to. A match at or " +
  "above it is served (when serving is on); uncalibrated spaces fall back to " +
  "the conservative default.\n\n" +
  "Individual configs can override these, in which case their own value wins " +
  "over the row here.";

// Display only — the apply control lives on the collision-floor heading row
// above, next to the recommendation it applies.
export function ThresholdsPanel() {
  const [rows, setRows] = useState<ThresholdReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch("/api/semantic-cache/thresholds")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setError(null);
          setRows(d.thresholds);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SC_CHANGED, load);
    return () => window.removeEventListener(SC_CHANGED, load);
  }, [load]);

  return (
    <Panel
      title="Thresholds by vector-space"
      about={ABOUT}
      subtitle="What every space serves at right now. Read-only."
    >
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {/* Borderless and bled to the card's edges: the card already draws the box,
          so a bordered table inside it was a second border a few pixels in from
          the first. */}
      <div className={TABLE_WRAP}>
        <table className="w-full text-sm">
          <thead className={TABLE_HEAD}>
            <tr>
              <th className="px-4 py-2 font-medium">Space</th>
              <th className="px-4 py-2 text-right font-medium">Threshold</th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Samples</th>
              <th className="px-4 py-2 font-medium">Calibrated</th>
              <th className="px-4 py-2 text-right font-medium">Cached</th>
              <th className="px-4 py-2 text-right font-medium">Hits</th>
              <th className="px-4 py-2 text-right font-medium">Shadow</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows === null && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-xs text-zinc-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-xs text-zinc-400">
                  No spaces yet — populate a cache, then calibrate with the collision
                  floor above or the would-hit queue below.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.space}>
                <td className="px-4 py-2 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                  {r.space}
                </td>
                {/* The one number the row exists for — everything else on it is
                    provenance, so it carries the weight. */}
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {r.threshold.toFixed(3)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      r.source === "calibrated"
                        ? "rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }
                    title={r.notes ?? undefined}
                  >
                    {r.source}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.sampleSize ?? "—"}
                </td>
                <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">
                  {fmtDate(r.calibratedAt)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.cacheEntries}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.totalHits}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.shadowJudged}/{r.shadowTotal}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
