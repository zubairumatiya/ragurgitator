// ---------------------------------------------------------------------------
// UI: "New config" dialog (Client Component) — Phase 3's custom-settings creation
// that makes real A/B testing possible. The user picks:
//   - a corpus: a fresh empty one, or an EXISTING one to spawn over (its stored
//     docs get re-embedded under the new settings — no re-upload)
//   - a base embedding model (greyed out when its provider key is missing / it
//     has no vector table — data from GET /api/embedding-models)
//   - chunk size / overlap / top-k
//
// On submit it POSTs /api/configs; for an existing corpus it then streams
// /api/configs/[id]/populate to embed that corpus's docs under the new config,
// showing progress. Then it routes to the new tab. Styling mirrors FileUpload /
// EvalDashboard (zinc palette).
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
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
}: {
  onClose: () => void;
  onCreated: (configId: string) => void;
}) {
  const [models, setModels] = useState<BaseModelOption[] | null>(null);
  const [corpora, setCorpora] = useState<CorpusSummary[] | null>(null);

  const [name, setName] = useState("");
  const [corpusKind, setCorpusKind] = useState<"new" | "existing">("new");
  const [corpusId, setCorpusId] = useState("");
  const [baseModel, setBaseModel] = useState(DEFAULTS.baseModel);
  const [chunkSize, setChunkSize] = useState(DEFAULTS.chunkSize);
  const [chunkOverlap, setChunkOverlap] = useState(DEFAULTS.chunkOverlap);
  const [topK, setTopK] = useState(DEFAULTS.topK);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // Load the model availability list + corpora when the dialog opens.
  useEffect(() => {
    apiFetch("/api/embedding-models")
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]));
    apiFetch("/api/corpora")
      .then((r) => r.json())
      .then((d) => setCorpora(d.corpora ?? []))
      .catch(() => setCorpora([]));
  }, []);

  const busy = phase.kind === "creating" || phase.kind === "spawning";
  const selectedModel = models?.find((m) => m.id === baseModel);
  const existingCorpus = corpora?.find((c) => c.id === corpusId);

  // Client-side gate; the server re-validates. overlap<size, a selectable model,
  // and (for an existing corpus) a chosen corpus.
  const formError =
    chunkOverlap >= chunkSize
      ? "Overlap must be smaller than chunk size."
      : selectedModel && !selectedModel.selectable
        ? selectedModel.reason
        : corpusKind === "existing" && !corpusId
          ? "Pick a corpus."
          : null;

  async function submit() {
    if (formError) return;
    setPhase({ kind: "creating" });

    const corpus =
      corpusKind === "existing"
        ? { kind: "existing" as const, id: corpusId }
        : { kind: "new" as const, name: name.trim() || undefined };

    let created: ConfigSummary;
    let spawned: boolean;
    try {
      const res = await apiFetch("/api/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, corpus, baseModel, chunkSize, chunkOverlap, topK }),
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

    // New empty corpus → nothing to embed; go straight to the tab.
    if (!spawned) {
      onCreated(created.id);
      return;
    }

    // Existing corpus → stream the re-embed of its stored docs under this config.
    try {
      const res = await apiFetch(`/api/configs/${created.id}/populate`, { method: "POST" });
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

        {/* Corpus: new vs existing */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Corpus</span>
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={corpusKind === "new"} onChange={() => setCorpusKind("new")} disabled={busy} />
              New (empty)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={corpusKind === "existing"} onChange={() => setCorpusKind("existing")} disabled={busy} />
              Existing
            </label>
          </div>
          {corpusKind === "existing" && (
            <>
              <select
                value={corpusId}
                onChange={(e) => setCorpusId(e.target.value)}
                disabled={busy || !corpora}
                className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
              >
                <option value="">{corpora ? "Select a corpus…" : "Loading…"}</option>
                {corpora?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.docCount} doc{c.docCount === 1 ? "" : "s"}, {c.embeddableCount} with text)
                  </option>
                ))}
              </select>
              {existingCorpus && existingCorpus.embeddableCount === 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-500">
                  No docs with stored text — this config would start empty. Re-ingest those docs first.
                </span>
              )}
              {existingCorpus && existingCorpus.embeddableCount > 0 && (
                <span className="text-xs text-zinc-400">
                  {existingCorpus.embeddableCount} doc(s) will be re-embedded under these settings.
                </span>
              )}
            </>
          )}
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
