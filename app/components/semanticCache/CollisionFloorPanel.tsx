// Appraise → Semantic caching: collision-floor calibration. Pick a config, compute
// the eval-bank collision floor for its vector-space (POST /collision-floor,
// config-scoped via ?configId=), review the safe band, and apply the recommended
// threshold. Pure arithmetic server-side — no LLM calls, available immediately.
"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { CollisionFloorReport } from "@/lib/rag/semanticCacheCalibration";

import { SC_CHANGED } from "./ThresholdsPanel";

const btn =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
const num = (n: number | null) => (n === null ? "—" : n.toFixed(4));

export function CollisionFloorPanel() {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [configId, setConfigId] = useState("");
  const [report, setReport] = useState<CollisionFloorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const compute = () => {
    if (!configId) return;
    setBusy(true);
    setError(null);
    setReport(null);
    apiFetch(`/api/semantic-cache/collision-floor?configId=${encodeURIComponent(configId)}`, {
      method: "POST",
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setReport(d.report);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const apply = () => {
    if (!report || report.recommended === null) return;
    setBusy(true);
    setError(null);
    apiFetch("/api/semantic-cache/thresholds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: report.space,
        threshold: report.recommended,
        sampleSize: report.distinctPairs + report.sameAnswerPairs,
        notes: `collision-floor (${report.embeddingModel}) floor=${num(report.floor)}`,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else window.dispatchEvent(new Event(SC_CHANGED));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Collision floor</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          From a config&apos;s labeled eval questions: the highest cosine between two
          questions with <em>different</em> ground-truth chunks is the floor — the
          closest two genuinely-different questions ever land. The threshold must sit
          above it. The recommendation adds a small margin and stays below the nearest
          same-answer pair, so it catches paraphrases with no false hit on the eval bank.
        </p>
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
          {busy ? "Computing…" : "Compute"}
        </button>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

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

          <div>
            <button
              type="button"
              className={btn}
              onClick={apply}
              disabled={busy || report.recommended === null}
            >
              Apply recommended to {report.space}
            </button>
          </div>
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
