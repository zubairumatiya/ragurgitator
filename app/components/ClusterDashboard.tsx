// ---------------------------------------------------------------------------
// UI: k-means clustering dashboard (/clusters).
//
// Set k and run k-means over the active corpus. Each run produces 3 candidates
// (random restarts) so the randomness is visible — keep the ones you like as
// named presets. Each bucket shows its cohesion; each run shows a
// silhouette score so different k can be compared fairly (cohesion alone always
// rises with k). The compare modal lines up headline metrics + sorted cohesion
// profiles for up to 5 runs (buckets aren't aligned across runs — numbering is
// arbitrary and k differs).
//
// Server compute + persistence live in lib/rag/cluster.ts + clusterStore.ts.
// ---------------------------------------------------------------------------
"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  BucketChunk,
  ClusterBucket,
  ClusterEvent,
  ClusterRunDetail,
  ClusterRunSummary,
} from "@/lib/rag/clusterStore";

const fmt = (n: number) => n.toFixed(3);

type Progress = { phase: "load" } | { phase: "restart"; index: number; total: number };

export function ClusterDashboard() {
  const [runs, setRuns] = useState<ClusterRunSummary[]>([]);
  const [k, setK] = useState(8);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);

  // Refreshes bump a key; the effect owns the fetch (keeps setState out of the
  // effect body — see EvalDashboard for the same pattern).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/clusters");
        const data = (await res.json()) as { runs?: ClusterRunSummary[] };
        if (alive && data.runs) setRuns(data.runs);
      } catch {
        // best-effort refresh
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function run() {
    setRunning(true);
    setError(null);
    setProgress({ phase: "load" });
    try {
      const res = await fetch("/api/clusters/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ k }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ClusterEvent;
          switch (event.type) {
            case "load":
              setProgress({ phase: "load" });
              break;
            case "restart":
              setProgress({ phase: "restart", index: event.index, total: event.total });
              break;
            case "done":
              break;
            case "error":
              setError(event.message);
              return;
          }
        }
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < 5) next.add(id);
      return next;
    });
  }

  const presets = runs.filter((r) => r.saved);
  // Candidates are the 3 restarts of the latest run; surface the best-separated first.
  const candidates = runs
    .filter((r) => !r.saved)
    .sort((a, b) => b.silhouette - a.silhouette);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const selectedRuns = [...selected]
    .map((id) => byId.get(id))
    .filter((r): r is ClusterRunSummary => r !== undefined);

  return (
    <div className="flex flex-col gap-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-zinc-500">k (buckets)</span>
          <input
            type="number"
            min={2}
            max={100}
            value={k}
            onChange={(e) => setK(Math.max(2, Math.min(100, Number(e.target.value) || 2)))}
            disabled={running}
            className="w-24 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 dark:border-zinc-700"
          />
        </label>
        <button
          onClick={run}
          disabled={running}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {running ? "Running…" : "Run k-means"}
        </button>
        <button
          onClick={() => setCompareOpen(true)}
          disabled={selectedRuns.length < 2}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Compare ({selectedRuns.length})
        </button>
      </div>

      {progress && <RunProgress progress={progress} />}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Latest run candidates */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Latest run — candidates
        </h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Run k-means to generate candidates, then save the ones you like.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                selected={selected.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onChanged={reload}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Saved presets */}
      {presets.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Saved presets
          </h2>
          <ul className="flex flex-col gap-2">
            {presets.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                selected={selected.has(r.id)}
                onToggleSelect={() => toggleSelect(r.id)}
                onChanged={reload}
              />
            ))}
          </ul>
        </section>
      )}

      {compareOpen && (
        <CompareModal runs={selectedRuns} onClose={() => setCompareOpen(false)} />
      )}
    </div>
  );
}

function RunProgress({ progress }: { progress: Progress }) {
  const label =
    progress.phase === "load"
      ? "Loading corpus vectors…"
      : `Clustering — candidate ${progress.index}/${progress.total}`;
  const percent =
    progress.phase === "load" ? 8 : Math.round((progress.index / progress.total) * 100);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-300 dark:bg-zinc-100"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
    </div>
  );
}

// One run: headline metrics + a checkbox to add it to a compare, expandable to
// the per-bucket breakdown. Candidates get a save-as-preset field; presets get a
// delete button.
function RunCard({
  run,
  selected,
  onToggleSelect,
  onChanged,
}: {
  run: ClusterRunSummary;
  selected: boolean;
  onToggleSelect: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ClusterRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function expand() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setLoading(true);
      try {
        const res = await fetch(`/api/clusters/${run.id}`);
        const data = await res.json();
        if (!data.error) setDetail(data as ClusterRunDetail);
      } catch {
        // leave detail null; header still shows
      } finally {
        setLoading(false);
      }
    }
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    await fetch(`/api/clusters/${run.id}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => {});
    setBusy(false);
    onChanged();
  }

  async function remove() {
    setBusy(true);
    await fetch(`/api/clusters/${run.id}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    onChanged();
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          title="Select for compare (up to 5)"
          className="cursor-pointer"
        />
        <button
          type="button"
          onClick={expand}
          className="flex flex-1 cursor-pointer flex-wrap items-center gap-2 text-left"
        >
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {run.name ?? `k=${run.k}`}
          </span>
          <span className="text-zinc-400">k={run.k}</span>
          <span className="text-zinc-500">
            cohesion <span className="tabular-nums">{fmt(run.avgCohesion)}</span>
          </span>
          <span className="text-zinc-500">
            silhouette <span className="tabular-nums">{fmt(run.silhouette)}</span>
          </span>
          <Bars values={run.sizes} max={Math.max(1, ...run.sizes)} title="bucket sizes" />
        </button>
        {run.saved && (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="shrink-0 cursor-pointer text-zinc-400 hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
          >
            ✕
          </button>
        )}
      </div>

      {!run.saved && (
        <div className="flex items-center gap-2 pl-6">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`name, e.g. "best k=${run.k}"`}
            className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy || !name.trim()}
            className="shrink-0 cursor-pointer rounded border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Save as preset
          </button>
        </div>
      )}

      {open && loading && (
        <p className="animate-pulse pl-6 text-xs text-zinc-400">Loading buckets…</p>
      )}
      {open && detail && (
        <ul className="flex flex-col gap-1 pl-6">
          {detail.buckets.map((b) => (
            <BucketRow key={b.id} runId={run.id} bucket={b} />
          ))}
        </ul>
      )}
    </li>
  );
}

// One bucket: cohesion + size + representative chunk, expandable to its members.
function BucketRow({ runId, bucket }: { runId: string; bucket: ClusterBucket }) {
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<BucketChunk[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function expand() {
    const next = !open;
    setOpen(next);
    if (next && !chunks) {
      setLoading(true);
      try {
        const res = await fetch(`/api/clusters/${runId}/buckets/${bucket.id}`);
        const data = await res.json();
        if (data.chunks) setChunks(data.chunks as BucketChunk[]);
      } catch {
        // leave null
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <li className="flex flex-col gap-0.5 border-t border-zinc-100 pt-1 dark:border-zinc-900">
      <button
        type="button"
        onClick={expand}
        className="-mx-1 flex w-full cursor-pointer flex-wrap items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
      >
        <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-zinc-500">#{bucket.ordinal}</span>
        <span className="text-zinc-400">{bucket.size} chunks</span>
        <span className="text-zinc-500">
          cohesion <span className="tabular-nums">{fmt(bucket.cohesion)}</span>
        </span>
        <CohesionBar value={bucket.cohesion} />
        {bucket.label ? (
          <span className="text-zinc-600 dark:text-zinc-400">{bucket.label}</span>
        ) : (
          bucket.representative && (
            <span className="truncate text-zinc-400" title={bucket.representative.snippet}>
              {bucket.representative.fileName} #{bucket.representative.position ?? "?"}:{" "}
              {bucket.representative.snippet}
            </span>
          )
        )}
      </button>
      {open && loading && (
        <p className="animate-pulse pl-5 pt-0.5 text-xs text-zinc-400">Loading chunks…</p>
      )}
      {open && chunks && (
        <ol className="flex flex-col gap-0.5 pl-5 pt-0.5">
          {chunks.map((c) => (
            <ChunkRow key={c.chunkId} chunk={c} />
          ))}
        </ol>
      )}
    </li>
  );
}

// One chunk in a bucket: similarity + source, expandable to its full text so you
// can read exactly what landed in the bucket. The text is already loaded with the
// bucket, so expanding is instant — no extra fetch.
function ChunkRow({ chunk }: { chunk: BucketChunk }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-1 text-xs text-zinc-500">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
      >
        <span className="shrink-0 text-zinc-400">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 tabular-nums text-zinc-400">{fmt(chunk.similarity)}</span>
        <span className={open ? "min-w-0" : "truncate"}>
          <span className="font-mono text-zinc-400">
            {chunk.fileName} #{chunk.position ?? "?"}
          </span>
          {!open && ` ${chunk.text.slice(0, 120)}`}
        </span>
      </button>
      {open && (
        <p className="whitespace-pre-wrap break-words pl-5 text-zinc-600 dark:text-zinc-400">
          {chunk.text}
        </p>
      )}
    </li>
  );
}

// Side-by-side compare of up to 5 runs: headline metrics + each run's sorted
// cohesion profile and size distribution. Buckets are NOT aligned across runs.
function CompareModal({
  runs,
  onClose,
}: {
  runs: ClusterRunSummary[];
  onClose: () => void;
}) {
  const maxSize = Math.max(1, ...runs.flatMap((r) => r.sizes));
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-4xl flex-col gap-4 overflow-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Compare {runs.length} runs
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(0, 1fr))` }}>
          {runs.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-2 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800"
            >
              <div className="font-medium text-zinc-700 dark:text-zinc-300">
                {r.name ?? `k=${r.k}`}
              </div>
              <Metric label="k" value={String(r.k)} />
              <Metric label="avg cohesion" value={fmt(r.avgCohesion)} />
              <Metric label="silhouette" value={fmt(r.silhouette)} />
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">cohesion profile</span>
                <Bars
                  values={[...r.cohesions].sort((a, b) => b - a)}
                  max={1}
                  className="h-8"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">sizes</span>
                <Bars values={r.sizes} max={maxSize} className="h-8" />
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-zinc-400">
          Buckets aren&apos;t aligned across runs (numbering is arbitrary and k differs), so
          this compares headline metrics and each run&apos;s sorted cohesion profile — not
          bucket-to-bucket.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-400">{label}</span>
      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{value}</span>
    </div>
  );
}

// A row of thin vertical bars (heights ∝ value / max). Used for size
// distributions and the sorted cohesion profile.
function Bars({
  values,
  max,
  className = "h-4",
  title,
}: {
  values: number[];
  max: number;
  className?: string;
  title?: string;
}) {
  const top = max > 0 ? max : 1;
  return (
    <span className={`inline-flex items-end gap-px ${className}`} title={title}>
      {values.map((v, i) => (
        <span
          key={i}
          className="w-1 rounded-sm bg-zinc-400 dark:bg-zinc-600"
          style={{ height: `${Math.max(8, (Math.max(0, v) / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

function CohesionBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 align-middle dark:bg-zinc-800">
      <span className="block h-full bg-emerald-500" style={{ width: `${pct}%` }} />
    </span>
  );
}
