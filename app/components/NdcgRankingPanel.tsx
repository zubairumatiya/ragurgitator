// ---------------------------------------------------------------------------
// Per-question graded-nDCG ranking builder, opened from a question row on /eval.
//
// Flow (see lib/rag/ranking): pick a saved cluster preset to seed a candidate
// pool, build the cross-model AGGREGATE ideal ranking, optionally add LLM
// rankings (pool / re-rank top-k) as comparisons, optionally hand-edit a MANUAL
// order — then mark ONE ranking as ground truth. nDCG scores the active model's
// retrieval against whichever is ground truth, so promoting one refreshes the
// question's chip + the headline via onChange.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import type {
  RankingCandidate,
  RankingContext,
  RankingItem,
} from "@/lib/rag/ranking";

const KIND_LABEL: Record<RankingCandidate["kind"], string> = {
  aggregate: "Embedding aggregate",
  llm_pool: "LLM · ranked pool",
  llm_rerank: "LLM · re-ranked top-k",
  manual: "Manual",
};

type Action =
  | { action: "aggregate"; clusterRunId: string }
  | { action: "llm_pool" }
  | { action: "llm_rerank" }
  | { action: "manual"; chunkIds: string[] }
  | { action: "truth"; rankingId: string };

export function NdcgRankingPanel({
  questionId,
  onChange,
}: {
  questionId: string;
  onChange: () => void;
}) {
  const [ctx, setCtx] = useState<RankingContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the running action's key
  const [presetId, setPresetId] = useState<string>("");
  const [manual, setManual] = useState<RankingItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/eval/questions/${questionId}/ranking`);
        const data = (await res.json()) as RankingContext | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setError("error" in data ? data.error : `Request failed (${res.status}).`);
          return;
        }
        setError(null);
        setCtx(data);
        setPresetId((p) => p || data.presets[0]?.id || "");
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [questionId]);

  async function act(body: Action) {
    setBusy(body.action);
    setError(null);
    try {
      const res = await fetch(`/api/eval/questions/${questionId}/ranking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as RankingContext | { error: string };
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : `Request failed (${res.status}).`);
        return;
      }
      setCtx(data);
      if (body.action === "manual") setManual(null);
      onChange(); // a truth/manual/rebuild can change the graded nDCG
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(null);
    }
  }

  if (!ctx && !error) {
    return <p className="mt-1 text-xs text-zinc-400">Loading ranking…</p>;
  }

  return (
    <div className="mt-1 flex flex-col gap-3 rounded border border-dashed border-zinc-300 p-2 text-xs dark:border-zinc-700">
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}

      {/* Step 1-3: seed a pool from a saved cluster preset, build the aggregate. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Seed pool from preset:</span>
        {ctx && ctx.presets.length > 0 ? (
          <>
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="rounded border border-zinc-300 bg-transparent px-1.5 py-0.5 dark:border-zinc-700"
            >
              {ctx.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? "unnamed"} (k={p.k})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => presetId && act({ action: "aggregate", clusterRunId: presetId })}
              disabled={busy !== null || !presetId}
              className="cursor-pointer rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {busy === "aggregate" ? "Building…" : "Build aggregate"}
            </button>
          </>
        ) : (
          <span className="text-zinc-400">
            Save a cluster preset on <span className="font-mono">/clusters</span> first.
          </span>
        )}
      </div>

      {/* Step 4: LLM comparisons — only once a pool (aggregate) exists. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Compare with LLM:</span>
        <button
          type="button"
          onClick={() => act({ action: "llm_pool" })}
          disabled={busy !== null || !ctx?.hasAggregate}
          title={ctx?.hasAggregate ? undefined : "Build the aggregate first"}
          className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {busy === "llm_pool" ? "Asking…" : "Rank pool"}
        </button>
        <button
          type="button"
          onClick={() => act({ action: "llm_rerank" })}
          disabled={busy !== null || !ctx?.hasAggregate}
          title={ctx?.hasAggregate ? undefined : "Build the aggregate first"}
          className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {busy === "llm_rerank" ? "Asking…" : "Re-rank top-k"}
        </button>
      </div>

      {/* The rankings built so far; promote one to ground truth. */}
      {ctx && ctx.candidates.length > 0 && (
        <div className="flex flex-col gap-2">
          {ctx.candidates.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              busy={busy !== null}
              onSetTruth={() => act({ action: "truth", rankingId: c.id })}
              onEditManual={() => setManual(c.items.map((it) => ({ ...it })))}
            />
          ))}
        </div>
      )}

      {/* Step 5: hand-edit an order, then save it as the manual ranking. */}
      {manual && (
        <ManualEditor
          items={manual}
          busy={busy !== null}
          onChange={setManual}
          onCancel={() => setManual(null)}
          onSave={() => act({ action: "manual", chunkIds: manual.map((i) => i.chunkId) })}
        />
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  busy,
  onSetTruth,
  onEditManual,
}: {
  candidate: RankingCandidate;
  busy: boolean;
  onSetTruth: () => void;
  onEditManual: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium text-zinc-600 dark:text-zinc-300">
          {KIND_LABEL[candidate.kind]}
          {candidate.isTruth && (
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
              ground truth
            </span>
          )}
          {candidate.llmModel && (
            <span className="font-mono text-[10px] text-zinc-400">{candidate.llmModel}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onEditManual}
            disabled={busy}
            className="cursor-pointer text-zinc-500 hover:underline disabled:opacity-50"
          >
            Edit as manual
          </button>
          {!candidate.isTruth && (
            <button
              type="button"
              onClick={onSetTruth}
              disabled={busy}
              className="cursor-pointer font-medium text-zinc-700 hover:underline disabled:opacity-50 dark:text-zinc-300"
            >
              Set as ground truth
            </button>
          )}
        </span>
      </div>
      <ol className="flex flex-col gap-0.5">
        {candidate.items.map((it, i) => (
          <li key={it.chunkId} className="flex items-baseline gap-1.5">
            <span className="w-4 shrink-0 text-right tabular-nums text-zinc-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="font-mono text-zinc-500">
                {it.fileName}#{it.position ?? "?"}
              </span>{" "}
              <span className="text-zinc-400">{it.preview}</span>
              {it.perModelRanks && (
                <span className="ml-1 font-mono text-[10px] text-zinc-400">
                  [
                  {Object.entries(it.perModelRanks)
                    .map(([m, r]) => `${m.replace(/^voyage-?/, "")}:${r}`)
                    .join(" ")}
                  ]
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ManualEditor({
  items,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  items: RankingItem[];
  busy: boolean;
  onChange: (items: RankingItem[]) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = items.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-1 rounded border border-indigo-300 p-2 dark:border-indigo-700">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-600 dark:text-zinc-300">Manual order</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={busy || items.length === 0}
            className="cursor-pointer rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {busy ? "Saving…" : "Save manual"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer text-zinc-500 hover:underline"
          >
            Cancel
          </button>
        </span>
      </div>
      <ol className="flex flex-col gap-0.5">
        {items.map((it, i) => (
          <li key={it.chunkId} className="flex items-baseline gap-1.5">
            <span className="w-4 shrink-0 text-right tabular-nums text-zinc-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="font-mono text-zinc-500">
                {it.fileName}#{it.position ?? "?"}
              </span>{" "}
              <span className="text-zinc-400">{it.preview}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-zinc-500">
              <button
                type="button"
                onClick={() => move(i, i - 1)}
                disabled={i === 0}
                className="cursor-pointer px-1 hover:text-zinc-800 disabled:opacity-30 dark:hover:text-zinc-100"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, i + 1)}
                disabled={i === items.length - 1}
                className="cursor-pointer px-1 hover:text-zinc-800 disabled:opacity-30 dark:hover:text-zinc-100"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                className="cursor-pointer px-1 text-red-500 hover:text-red-700"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
