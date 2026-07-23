// Appraise → Semantic caching: the per-space threshold + stats table. Reads
// GET /api/semantic-cache/thresholds and refreshes whenever a calibration panel
// applies a new threshold (the SC_CHANGED window event).
"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/http/client";
import type { ThresholdReport } from "@/lib/rag/semanticCacheCalibration";

// Fired by the calibration panels after an Apply so this table re-pulls.
export const SC_CHANGED = "sc:thresholds-changed";

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Thresholds by vector-space
      </h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        The active cosine threshold for each embedding space, across every config.
        A match at or above it is served (when serving is on). Uncalibrated spaces
        fall back to the conservative default.
      </p>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Space</th>
              <th className="px-3 py-2 text-right font-medium">Threshold</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 text-right font-medium">Samples</th>
              <th className="px-3 py-2 font-medium">Calibrated</th>
              <th className="px-3 py-2 text-right font-medium">Cached</th>
              <th className="px-3 py-2 text-right font-medium">Hits</th>
              <th className="px-3 py-2 text-right font-medium">Shadow</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-xs text-zinc-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-xs text-zinc-400">
                  No spaces yet — populate a cache and calibrate below.
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.space} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.space}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-800 dark:text-zinc-200">
                  {r.threshold.toFixed(3)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      r.source === "calibrated"
                        ? "rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300"
                        : "rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }
                    title={r.notes ?? undefined}
                  >
                    {r.source}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.sampleSize ?? "—"}
                </td>
                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{fmtDate(r.calibratedAt)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.cacheEntries}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.totalHits}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.shadowJudged}/{r.shadowTotal}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
