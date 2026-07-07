// ---------------------------------------------------------------------------
// UI: "New config" dialog (Client Component) — custom-settings creation for
// real A/B testing. The user picks:
//   - 0..n source CORPORA (multi-select; their docs are union'd and de-duped by
//     content hash — the picker warns on duplicates). None = start blank.
//   - optionally "save selection as new corpus" (a merged, reusable corpus) and
//     "auto-sync" (corpus ↔ config membership flows both ways; needs a single
//     target corpus — the one selected, or the newly saved one).
//   - a base embedding model (greyed out when its provider key is missing / it
//     has no vector table — data from GET /api/embedding-models)
//   - chunk size / overlap / top-k
//
// On submit it POSTs /api/configs; with source corpora it then streams
// /api/configs/[id]/populate (body { corpusIds }) to embed the de-duped docs
// under the new config, showing progress. Then it routes to the new tab.
// Styling mirrors FileUpload / EvalDashboard (zinc palette).
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import { CorpusPicker } from "@/app/components/CorpusPicker";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { CorpusSummary } from "@/lib/rag/corpusStore";
import type { BaseModelOption } from "@/lib/rag/embeddingModels";
import type { IngestEvent } from "@/lib/rag/pipeline";

// Sensible starting points (match lib/config.ts defaults). The user tweaks these
// per config — that's the whole point of A/B.
const DEFAULTS = { baseModel: "voyage-4-lite", chunkSize: 512, chunkOverlap: 50, topK: 5 };

type Phase =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "spawning"; done: number; total: number; file: string }
  | { kind: "error"; message: string };

export function ConfigCreateDialog({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (configId: string) => void;
  // Pre-fill for the "Bulk actions → Change base model / chunk size" shortcut
  // (D2): defaults to spawning a new config over `corpusId` with these settings.
  initial?: {
    corpusId?: string;
    baseModel?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    topK?: number;
  };
}) {
  const [models, setModels] = useState<BaseModelOption[] | null>(null);
  const [corpora, setCorpora] = useState<CorpusSummary[] | null>(null);

  const [name, setName] = useState("");
  const [corpusIds, setCorpusIds] = useState<string[]>(
    initial?.corpusId ? [initial.corpusId] : [],
  );
  const [saveAs, setSaveAs] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [sync, setSync] = useState(false);
  const [baseModel, setBaseModel] = useState(initial?.baseModel ?? DEFAULTS.baseModel);
  const [chunkSize, setChunkSize] = useState(initial?.chunkSize ?? DEFAULTS.chunkSize);
  const [chunkOverlap, setChunkOverlap] = useState(
    initial?.chunkOverlap ?? DEFAULTS.chunkOverlap,
  );
  const [topK, setTopK] = useState(initial?.topK ?? DEFAULTS.topK);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // Load the model availability list + corpora when the dialog opens.
  useEffect(() => {
    apiFetch("/api/embedding-models")
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]));
    // includeEmpty: a corpus created on the corpora page starts doc-less on
    // purpose — attaching a config to it here is how it gets its documents.
    apiFetch("/api/corpora?includeEmpty=1")
      .then((r) => r.json())
      .then((d) => setCorpora(d.corpora ?? []))
      .catch(() => setCorpora([]));
  }, []);

  const busy = phase.kind === "creating" || phase.kind === "spawning";
  const selectedModel = models?.find((m) => m.id === baseModel);

  // Auto-sync needs one unambiguous target corpus: the single selection, or
  // the freshly saved merged one.
  const syncPossible = corpusIds.length === 1 || saveAs;

  // Client-side gate; the server re-validates. overlap<size + a selectable model.
  const formError =
    chunkOverlap >= chunkSize
      ? "Overlap must be smaller than chunk size."
      : selectedModel && !selectedModel.selectable
        ? selectedModel.reason
        : null;

  async function submit() {
    if (formError) return;
    setPhase({ kind: "creating" });

    let created: ConfigSummary;
    let spawned: boolean;
    try {
      const res = await apiFetch("/api/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          corpusIds,
          saveAsCorpus: saveAs
            ? { name: saveAsName.trim() || name.trim() || "New corpus" }
            : undefined,
          sync: sync && syncPossible,
          baseModel,
          chunkSize,
          chunkOverlap,
          topK,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { config?: ConfigSummary; spawned?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.config) {
        setPhase({ kind: "error", message: data?.error ?? `Create failed (${res.status}).` });
        return;
      }
      created = data.config;
      spawned = Boolean(data.spawned);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Network error." });
      return;
    }

    // No source corpora → nothing to embed; go straight to the tab.
    if (!spawned) {
      onCreated(created.id);
      return;
    }

    // Stream the embed of the selection's de-duped docs under this config.
    try {
      const res = await apiFetch(`/api/configs/${created.id}/populate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corpusIds }),
      });
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setPhase({ kind: "error", message: d?.error ?? `Spawn failed (${res.status}).` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let total = 0;
      let done = 0;
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as IngestEvent;
          if (ev.type === "start") total = ev.total;
          else if (ev.type === "step") setPhase({ kind: "spawning", done, total, file: ev.fileName });
          else if (ev.type === "file-done") {
            done += 1;
            setPhase({ kind: "spawning", done, total, file: "" });
          } else if (ev.type === "error") {
            setPhase({ kind: "error", message: ev.message });
            return;
          }
        }
      }
      onCreated(created.id);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Spawn error." });
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">New config</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="e.g. mxbai · 256/25"
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>

        {/* Source corpora: multi-select with duplicate detection. */}
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">
            Corpora <span className="text-xs text-zinc-400">(optional — none = start blank)</span>
          </span>
          {corpora === null ? (
            <span className="text-xs text-zinc-400">Loading…</span>
          ) : (
            <CorpusPicker
              corpora={corpora}
              selected={corpusIds}
              onChange={setCorpusIds}
              disabled={busy}
            />
          )}

          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={saveAs}
              onChange={(e) => setSaveAs(e.target.checked)}
              disabled={busy}
            />
            Save selection as new corpus
          </label>
          {saveAs && (
            <input
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              disabled={busy}
              placeholder={name.trim() || "Corpus name (defaults to config name)"}
              className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
          )}

          <label
            className={`flex items-center gap-1.5 ${
              syncPossible
                ? "text-zinc-600 dark:text-zinc-400"
                : "text-zinc-400 dark:text-zinc-600"
            }`}
          >
            <input
              type="checkbox"
              checked={sync && syncPossible}
              onChange={(e) => setSync(e.target.checked)}
              disabled={busy || !syncPossible}
            />
            Auto-sync corpus
            <span
              className="cursor-help rounded-full border border-zinc-300 px-1.5 text-xs text-zinc-400 dark:border-zinc-700"
              title={
                "Changes to the corpus affect the config and vice versa: documents " +
                "added to the corpus are embedded into the config, documents removed " +
                "are removed, and documents uploaded in the config join the corpus. " +
                "You can toggle this later from the config's banner."
              }
            >
              ?
            </span>
            {!syncPossible && (
              <span className="text-xs">(select exactly one corpus, or save as new)</span>
            )}
          </label>
        </div>

        {/* Base model (greyed when not selectable) */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Embedding model</span>
          <select
            value={baseModel}
            onChange={(e) => setBaseModel(e.target.value)}
            disabled={busy || !models}
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          >
            {models?.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.selectable}>
                {m.label} ({m.dimension}d){m.selectable ? "" : ` — ${m.reason}`}
              </option>
            ))}
          </select>
        </label>

        {/* Chunk size / overlap / top-k */}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <NumberField label="Chunk size" value={chunkSize} onChange={setChunkSize} disabled={busy} min={1} />
          <NumberField label="Overlap" value={chunkOverlap} onChange={setChunkOverlap} disabled={busy} min={0} />
          <NumberField label="Top-k" value={topK} onChange={setTopK} disabled={busy} min={1} />
        </div>

        {phase.kind === "spawning" && (
          <p className="text-xs text-zinc-500">
            Embedding corpus… {phase.done}/{phase.total} {phase.file && `· ${phase.file}`}
          </p>
        )}
        {phase.kind === "error" && <p className="text-sm text-red-600 dark:text-red-400">{phase.message}</p>}
        {phase.kind === "form" && formError && (
          <p className="text-xs text-amber-600 dark:text-amber-500">{formError}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || Boolean(formError)}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  min,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  min: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
      />
    </label>
  );
}
