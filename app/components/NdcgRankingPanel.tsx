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
import { apiFetch } from "@/lib/http/client";
import type {
  LlmStatus,
  RankingCandidate,
  RankingContext,
  RankingItem,
  RankingPreset,
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
  | { action: "manual"; chunkIds: string[]; derivedFromKind?: RankingCandidate["kind"] }
  | { action: "truth"; rankingId: string };

export function NdcgRankingPanel({
  questionId,
  onChange,
  onClose,
}: {
  questionId: string;
  onChange: () => void;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<RankingContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // the running action's key
  const [presetId, setPresetId] = useState<string>("");
  const [manual, setManual] = useState<RankingItem[] | null>(null);
  // The ranking kind a manual edit was started from, so the save records it and
  // the panel can fold the original in place of the edit.
  const [manualSource, setManualSource] = useState<RankingCandidate["kind"] | undefined>(
    undefined,
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/eval/questions/${questionId}/ranking`);
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

  // Escape dismisses the panel — the toggle link that opened it is usually far
  // above a fully-built panel, so it needs its own way out.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function act(body: Action) {
    setBusy(body.action);
    setError(null);
    try {
      const res = await apiFetch(`/api/eval/questions/${questionId}/ranking`, {
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
      if (body.action === "manual") {
        setManual(null);
        setManualSource(undefined);
      }
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
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          nDCG ranking builder
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ✕
        </button>
      </div>
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}

      {/* Step 1-3: seed a pool from a saved cluster preset, build the aggregate.
          Runs render as collapsed cards (silhouette/cohesion in the header, the
          per-bucket profile on expand); pick one, then build. */}
      <div className="flex flex-col gap-1">
        <span className="text-zinc-500">Seed pool from preset:</span>
        {ctx && ctx.presets.length > 0 ? (
          <div className="flex flex-col gap-1">
            {ctx.presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                selected={p.id === presetId}
                onSelect={() => setPresetId(p.id)}
              />
            ))}
            <button
              type="button"
              onClick={() => presetId && act({ action: "aggregate", clusterRunId: presetId })}
              disabled={busy !== null || !presetId}
              className="cursor-pointer self-start rounded bg-black px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {busy === "aggregate" ? "Building…" : "Build aggregate"}
            </button>
          </div>
        ) : (
          <span className="text-zinc-400">
            Save a cluster preset on <span className="font-mono">/clusters</span> first.
          </span>
        )}
      </div>

      {/* Step 4: LLM comparisons — only once a pool (aggregate) exists. A 'fresh'
          ranking is cached (button disabled, no re-spend); 'stale' offers a rebuild. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Compare with LLM:</span>
        <LlmButton
          label="Rank pool"
          status={ctx?.llmStatus.pool ?? "none"}
          hasAggregate={!!ctx?.hasAggregate}
          busy={busy !== null}
          running={busy === "llm_pool"}
          onClick={() => act({ action: "llm_pool" })}
        />
        <LlmButton
          label="Re-rank top-k"
          status={ctx?.llmStatus.rerank ?? "none"}
          hasAggregate={!!ctx?.hasAggregate}
          busy={busy !== null}
          running={busy === "llm_rerank"}
          onClick={() => act({ action: "llm_rerank" })}
        />
      </div>

      {/* The rankings built so far; promote one to ground truth. A manual edit is
          shown in its source's place, with the source folded (see orderedCandidates). */}
      {ctx && ctx.candidates.length > 0 && (
        <div className="flex flex-col gap-2">
          {orderedCandidates(ctx.candidates).map(({ candidate, defaultOpen }) => (
            <CandidateCard
              key={`${candidate.id}:${defaultOpen}`}
              candidate={candidate}
              defaultOpen={defaultOpen}
              busy={busy !== null}
              onSetTruth={() => act({ action: "truth", rankingId: candidate.id })}
              onEditManual={() => {
                setManual(candidate.items.map((it) => ({ ...it })));
                // Editing the in-place manual keeps the ranking it folds; editing
                // any other card folds that card.
                setManualSource(
                  candidate.kind === "manual" ? candidate.derivedFromKind : candidate.kind,
                );
              }}
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
          onCancel={() => {
            setManual(null);
            setManualSource(undefined);
          }}
          onSave={() =>
            act({
              action: "manual",
              chunkIds: manual.map((i) => i.chunkId),
              derivedFromKind: manualSource,
            })
          }
        />
      )}
    </div>
  );
}

// Render order for the candidate cards. When a manual edit was derived from
// another ranking, the manual takes that ranking's place and the original is
// folded (defaultOpen=false) right below it; otherwise everything renders open.
function orderedCandidates(
  cands: RankingCandidate[],
): { candidate: RankingCandidate; defaultOpen: boolean }[] {
  const manual = cands.find((c) => c.kind === "manual");
  const sourceKind = manual?.derivedFromKind;
  const source =
    sourceKind && sourceKind !== "manual"
      ? cands.find((c) => c.kind === sourceKind)
      : undefined;
  if (!manual || !source) {
    return cands.map((candidate) => ({ candidate, defaultOpen: true }));
  }
  const rest = cands.filter((c) => c !== manual && c !== source);
  return [
    { candidate: manual, defaultOpen: true },
    { candidate: source, defaultOpen: false },
    ...rest.map((candidate) => ({ candidate, defaultOpen: true })),
  ];
}

// A saved cluster preset, collapsed to its quality headline (silhouette +
// cohesion); expand to see the per-bucket sizes/cohesions. Selecting it seeds the
// aggregate pool.
function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: RankingPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded border p-1.5 ${
        selected
          ? "border-zinc-400 bg-zinc-50 dark:border-zinc-500 dark:bg-zinc-800/50"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input type="radio" checked={selected} onChange={onSelect} className="shrink-0" />
          <span className="truncate font-medium text-zinc-600 dark:text-zinc-300">
            {preset.name ?? "unnamed"}
          </span>
          <span className="shrink-0 tabular-nums text-[10px] text-zinc-400">
            k={preset.k} · {preset.chunkCount} chunks · sil {preset.silhouette.toFixed(2)} · coh{" "}
            {preset.avgCohesion.toFixed(2)}
          </span>
        </label>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide buckets" : "Show buckets"}
          className="shrink-0 cursor-pointer text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      {open && (
        <ol className="mt-1 flex flex-col gap-0.5 pl-6 tabular-nums text-zinc-400">
          {preset.sizes.map((size, i) => (
            <li key={i} className="flex items-baseline gap-1.5">
              <span className="w-6 shrink-0 text-right">#{i}</span>
              <span>{size} chunks</span>
              <span>· coh {preset.cohesions[i]?.toFixed(2) ?? "—"}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// One LLM-ranking button whose label reflects cache state: base label when none
// exists, "✓" + disabled when cached/fresh (no re-spend), "↻" rebuild when stale.
function LlmButton({
  label,
  status,
  hasAggregate,
  busy,
  running,
  onClick,
}: {
  label: string;
  status: LlmStatus;
  hasAggregate: boolean;
  busy: boolean;
  running: boolean;
  onClick: () => void;
}) {
  const fresh = status === "fresh";
  const text = running ? "Asking…" : `${label}${fresh ? " ✓" : status === "stale" ? " ↻" : ""}`;
  const title = !hasAggregate
    ? "Build the aggregate first"
    : fresh
      ? "Cached — inputs unchanged since last run; re-requesting is disabled to avoid spend"
      : status === "stale"
        ? "Inputs changed since last run — click to rebuild"
        : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || !hasAggregate || fresh}
      title={title}
      className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {text}
    </button>
  );
}

function CandidateCard({
  candidate,
  defaultOpen,
  busy,
  onSetTruth,
  onEditManual,
}: {
  candidate: RankingCandidate;
  defaultOpen: boolean;
  busy: boolean;
  onSetTruth: () => void;
  onEditManual: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1 rounded border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        {/* The whole label is the section toggle; actions stay separate so they
            don't collapse the card when clicked. */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 cursor-pointer items-center gap-2 text-left font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          <span className="w-3 shrink-0 text-zinc-400">{open ? "▾" : "▸"}</span>
          <span className="truncate">{KIND_LABEL[candidate.kind]}</span>
          {candidate.isTruth && (
            <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
              ground truth
            </span>
          )}
          {candidate.llmModel && (
            <span className="shrink-0 font-mono text-[10px] text-zinc-400">{candidate.llmModel}</span>
          )}
          <span className="shrink-0 tabular-nums text-[10px] text-zinc-400">
            {candidate.items.length} {candidate.items.length === 1 ? "chunk" : "chunks"}
          </span>
          <span
            className="shrink-0 tabular-nums text-[10px] text-zinc-400"
            title="nDCG the active model's retrieval would score if this ranking were ground truth"
          >
            nDCG {candidate.ndcg == null ? "—" : candidate.ndcg.toFixed(2)}
          </span>
        </button>
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
      {open && (
        <ol className="flex flex-col gap-0.5">
          {candidate.items.map((it, i) => (
            <ChunkRow key={it.chunkId} item={it} index={i} />
          ))}
        </ol>
      )}
    </div>
  );
}

// One chunk in a ranking, collapsed to its title (file#pos + per-model ranks);
// click to reveal the preview text. Title-only by default so a card reads as a
// scannable list of chunks rather than a wall of previews.
function ChunkRow({ item, index }: { item: RankingItem; index: number }) {
  const [open, setOpen] = useState(false);
  const hasPreview = item.preview.length > 0;
  return (
    <li className="flex items-baseline gap-1.5">
      <span className="w-4 shrink-0 text-right tabular-nums text-zinc-400">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasPreview && setOpen((o) => !o)}
          className={
            hasPreview
              ? "cursor-pointer text-left hover:text-zinc-700 dark:hover:text-zinc-200"
              : "cursor-default text-left"
          }
        >
          <span className="font-mono text-zinc-500">
            {item.fileName}#{item.position ?? "?"}
          </span>
          {item.perModelRanks && (
            <span className="ml-1 font-mono text-[10px] text-zinc-400">
              [
              {Object.entries(item.perModelRanks)
                .map(([m, r]) => `${m.replace(/^voyage-?/, "")}:${r}`)
                .join(" ")}
              ]
            </span>
          )}
        </button>
        {open && <span className="mt-0.5 block text-zinc-400">{item.preview}</span>}
      </div>
    </li>
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
