// ---------------------------------------------------------------------------
// UI: the config Settings dropdown (Client Component), mounted on the RIGHT of
// the Nav (see Nav.tsx) so it's reachable from every config view, not just
// /eval. Extracted from EvalDashboard.
//
// Sections: eval METRICS (per-metric enable + k + optional min-rate, A1),
// AUTOTUNING (A5; consumed by the autotune engine), CORPUS (the auto-sync
// toggle — corpus ↔ config membership sync, 0017), and the greyed "Long-term
// savings" Phase E stub.
//
// Self-sufficient: opens by seeding from GET /api/eval/criteria (criteria +
// config summary), saves via PATCH /api/eval/criteria (+ PATCH
// /api/configs/[id] when auto-sync changed), then fires EVAL_CRITERIA_CHANGED
// (the eval dashboard re-pulls its summary) and router.refresh() (the banner
// re-renders). apiFetch scopes everything to the tab in the URL.
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { AutotuneApply, AutotuneSearch, EvalCriteria } from "@/lib/rag/evalSettingsStore";

// Fired (on window) after a successful save so config-scoped views (the eval
// dashboard) can re-pull data that depends on the criteria.
export const EVAL_CRITERIA_CHANGED = "eval:criteria-changed";

// "" / invalid => null (the metric falls back to the config's top_k, A1).
function parseKOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// "" / invalid => null (metric runs but isn't an autotune target). Clamped 0..1.
function parseRateOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

export function EvalSettings() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [recallOn, setRecallOn] = useState(true);
  const [recallK, setRecallK] = useState("");
  const [recallMin, setRecallMin] = useState("");
  const [ndcgOn, setNdcgOn] = useState(true);
  const [ndcgK, setNdcgK] = useState("");
  const [ndcgMin, setNdcgMin] = useState("");
  const [ladder, setLadder] = useState("");
  const [overlap, setOverlap] = useState("");
  const [apply, setApply] = useState<AutotuneApply>("choose");
  const [search, setSearch] = useState<AutotuneSearch>("first_success");
  const [sync, setSync] = useState(false);
  const [savedSync, setSavedSync] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetch the saved criteria + config and seed the form, then open — so it
  // always reflects the latest saved state without a render-cascading effect.
  async function seedAndOpen() {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/eval/criteria");
      const data = (await res.json().catch(() => null)) as
        | { criteria?: EvalCriteria; config?: ConfigSummary; error?: string }
        | null;
      if (!res.ok || !data?.criteria || !data.config) {
        setErr(data?.error ?? `Failed to load settings (${res.status}).`);
        setOpen(true);
        return;
      }
      const c = data.criteria;
      setConfig(data.config);
      setRecallOn(c.recall.enabled);
      setRecallK(c.recall.k != null ? String(c.recall.k) : "");
      setRecallMin(c.recall.minRate != null ? String(c.recall.minRate) : "");
      setNdcgOn(c.ndcg.enabled);
      setNdcgK(c.ndcg.k != null ? String(c.ndcg.k) : "");
      setNdcgMin(c.ndcg.minRate != null ? String(c.ndcg.minRate) : "");
      setLadder(c.autotune.sizeLadder.join(", "));
      setOverlap(String(Math.round(c.autotune.overlapPct * 100)));
      setApply(c.autotune.apply);
      setSearch(c.autotune.search);
      setSync(data.config.corpusSync);
      setSavedSync(data.config.corpusSync);
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    const ladderArr = ladder
      .split(/[\s,]+/)
      .map((s) => Math.floor(Number(s)))
      .filter((n) => Number.isFinite(n) && n > 0);
    const overlapNum = Number(overlap);
    const patch = {
      recall: { enabled: recallOn, k: parseKOrNull(recallK), minRate: parseRateOrNull(recallMin) },
      ndcg: { enabled: ndcgOn, k: parseKOrNull(ndcgK), minRate: parseRateOrNull(ndcgMin) },
      autotune: {
        ...(ladderArr.length > 0 ? { sizeLadder: ladderArr } : {}),
        ...(Number.isFinite(overlapNum)
          ? { overlapPct: Math.min(0.9, Math.max(0, overlapNum / 100)) }
          : {}),
        apply,
        search,
      },
    };
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/eval/criteria", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setErr(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      // Auto-sync lives on the config row, not the criteria — separate PATCH,
      // only when it actually changed.
      if (config && config.corpusId && sync !== savedSync) {
        const res2 = await apiFetch(`/api/configs/${config.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ corpusSync: sync }),
        });
        const data2 = (await res2.json().catch(() => null)) as { error?: string } | null;
        if (!res2.ok) {
          setErr(data2?.error ?? `Sync update failed (${res2.status}).`);
          return;
        }
      }
      setOpen(false);
      window.dispatchEvent(new Event(EVAL_CRITERIA_CHANGED));
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : seedAndOpen())}
        disabled={loading}
        title="Config settings: eval metrics, autotuning, corpus auto-sync"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {loading ? "Settings…" : "Settings ▾"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-md border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            {/* METRICS */}
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Metrics
            </p>
            <MetricRow
              label="Recall"
              on={recallOn}
              setOn={setRecallOn}
              k={recallK}
              setK={setRecallK}
              min={recallMin}
              setMin={setRecallMin}
              topK={config?.topK ?? 5}
            />
            <MetricRow
              label="nDCG"
              on={ndcgOn}
              setOn={setNdcgOn}
              k={ndcgK}
              setK={setNdcgK}
              min={ndcgMin}
              setMin={setNdcgMin}
              topK={config?.topK ?? 5}
            />

            {/* AUTOTUNING */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Autotuning
            </p>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">Size ladder</span>
              <input
                value={ladder}
                onChange={(e) => setLadder(e.target.value)}
                placeholder="384, 256, 192, 128"
                className="w-44 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">Overlap %</span>
              <input
                type="number"
                min={0}
                max={90}
                value={overlap}
                onChange={(e) => setOverlap(e.target.value)}
                className="w-20 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
              />
            </label>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">When 1+ pass</span>
              <div className="flex gap-1">
                <Seg active={apply === "choose"} onClick={() => setApply("choose")}>
                  choose
                </Seg>
                <Seg active={apply === "auto_best"} onClick={() => setApply("auto_best")}>
                  auto-best
                </Seg>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-zinc-600 dark:text-zinc-400">Search</span>
              <div className="flex gap-1">
                <Seg
                  active={search === "first_success"}
                  onClick={() => setSearch("first_success")}
                >
                  first
                </Seg>
                <Seg
                  active={search === "exhaustive"}
                  onClick={() => setSearch("exhaustive")}
                  title="Best-of-best: tries every size × model combo — slower / more costly"
                >
                  best-of-best
                </Seg>
              </div>
            </div>

            {/* CORPUS (auto-sync, 0017) */}
            <p className="mb-1 mt-3 border-t border-zinc-200 pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              Corpus
            </p>
            {config?.corpusId ? (
              <div className="flex items-center justify-between gap-2 py-0.5">
                <Link
                  href={`/corpora/${config.corpusId}`}
                  className="truncate text-zinc-600 hover:underline dark:text-zinc-400"
                  title="Open this corpus"
                >
                  {config.corpusName}
                </Link>
                <label
                  className="flex shrink-0 cursor-pointer items-center gap-1.5 text-zinc-600 dark:text-zinc-400"
                  title={
                    "Auto-sync: documents added to the corpus are embedded into this " +
                    "config, documents removed are removed, and this config's uploads " +
                    "join the corpus."
                  }
                >
                  <input
                    type="checkbox"
                    checked={sync}
                    onChange={(e) => setSync(e.target.checked)}
                  />
                  auto-sync
                </label>
              </div>
            ) : (
              <p className="py-0.5 text-xs text-zinc-400">
                No corpus attached — nothing to sync with.
              </p>
            )}

            {/* LONG-TERM SAVINGS (deferred — Phase E stub) */}
            <button
              type="button"
              disabled
              title="Coming soon — cut ongoing cost without dropping below your min-rate"
              className="mt-3 w-full cursor-not-allowed rounded border border-dashed border-zinc-300 px-2 py-1.5 text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-500"
            >
              Long-term savings (coming soon)
            </button>

            {err && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{err}</p>}

            <div className="mt-3 flex justify-end border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <button
                type="button"
                onClick={save}
                disabled={saving || !config}
                className="rounded-md bg-black px-3 py-1 text-xs font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// One metric row in the Settings dropdown: enable checkbox + k + optional min-rate.
function MetricRow({
  label,
  on,
  setOn,
  k,
  setK,
  min,
  setMin,
  topK,
}: {
  label: string;
  on: boolean;
  setOn: (v: boolean) => void;
  k: string;
  setK: (v: string) => void;
  min: string;
  setMin: (v: string) => void;
  topK: number;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <label className="flex w-20 cursor-pointer items-center gap-1.5">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span className="text-zinc-700 dark:text-zinc-300">{label}</span>
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        k
        <input
          type="number"
          min={1}
          value={k}
          onChange={(e) => setK(e.target.value)}
          placeholder={String(topK)}
          disabled={!on}
          className="w-14 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        min
        <input
          value={min}
          onChange={(e) => setMin(e.target.value)}
          placeholder="–"
          disabled={!on}
          className="w-16 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        />
      </label>
    </div>
  );
}

// A small segmented-control button used by the autotuning apply/search toggles.
function Seg({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`cursor-pointer rounded border px-2 py-0.5 text-xs font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
