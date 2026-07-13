// ---------------------------------------------------------------------------
// UI: "Change this config" dialog (Client Component) — the bulk-actions flow
// that mutates the CURRENT config in place (unlike ConfigCreateDialog, which
// spawns a new one; use + / Duplicate on the tab bar for that).
//
// Config-wide scope: PATCHes settings via POST /api/configs/[id]/reconfigure,
// which re-embeds the config's documents and remaps eval labels; scores go
// stale until the next re-score. Document scope (a document picked in Bulk
// actions): the same route applies the change to that document's chunks as
// per-chunk overrides — the config row is untouched.
//
// Streams the route's IngestEvents into a progress line. Styling mirrors
// ConfigCreateDialog (zinc palette).
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/http/client";
import type { EvalConfigInfo } from "@/lib/rag/evalStore";
import type { BaseModelOption } from "@/lib/rag/embeddingModels";
import type { IngestEvent, IngestResult } from "@/lib/rag/pipeline";

type Phase =
  | { kind: "form" }
  | { kind: "running"; done: number; total: number; file: string }
  | { kind: "done"; results: IngestResult[] }
  | { kind: "error"; message: string };

export function ConfigChangeDialog({
  config,
  documentIds,
  documentNames,
  onClose,
  onDone,
}: {
  config: EvalConfigInfo;
  // Bulk-actions document scope (one or more documents): null = the whole config.
  documentIds: string[] | null;
  documentNames: string[] | null;
  onClose: () => void;
  // Called after a successful run so the dashboard reloads (labels/settings changed).
  onDone: () => void;
}) {
  const [models, setModels] = useState<BaseModelOption[] | null>(null);
  const [baseModel, setBaseModel] = useState(config.baseModel);
  const [chunkSize, setChunkSize] = useState(config.chunkSize);
  const [chunkOverlap, setChunkOverlap] = useState(config.chunkOverlap);
  const [topK, setTopK] = useState(config.topK);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const docScoped = documentIds !== null && documentIds.length > 0;

  useEffect(() => {
    apiFetch("/api/embedding-models")
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]));
  }, []);

  const busy = phase.kind === "running";
  const selectedModel = models?.find((m) => m.id === baseModel);

  const changedModel = baseModel !== config.baseModel;
  const changedShape = chunkSize !== config.chunkSize || chunkOverlap !== config.chunkOverlap;
  const changedTopK = !docScoped && topK !== config.topK;
  const nothingChanged = !changedModel && !changedShape && !changedTopK;

  const formError =
    chunkOverlap >= chunkSize
      ? "Overlap must be smaller than chunk size."
      : selectedModel && !selectedModel.selectable && changedModel
        ? selectedModel.reason
        : docScoped && !changedModel && !changedShape
          ? "Pick a different model and/or chunk size for this document."
          : null;

  async function submit() {
    if (formError || nothingChanged) return;
    setPhase({ kind: "running", done: 0, total: 0, file: "" });
    try {
      const body: Record<string, unknown> = {};
      if (changedModel) body.baseModel = baseModel;
      if (chunkSize !== config.chunkSize || docScoped) body.chunkSize = chunkSize;
      if (chunkOverlap !== config.chunkOverlap || docScoped) body.chunkOverlap = chunkOverlap;
      if (changedTopK) body.topK = topK;
      if (docScoped && !changedShape) {
        // Doc scope only ever overrides model/shape — strip a shape that didn't
        // actually change so a pure model swap stays a model override.
        delete body.chunkSize;
        delete body.chunkOverlap;
      }

      // The reconfigure route takes one documentId per call, so a multi-doc
      // scope runs sequentially; results accumulate across the runs. Unscoped
      // is a single config-wide call (documentId absent).
      const scopes: (string | null)[] = docScoped ? documentIds! : [null];
      const results: IngestResult[] = [];
      for (const docId of scopes) {
        const scopedBody = docId === null ? body : { ...body, documentId: docId };
        const res = await apiFetch(`/api/configs/${config.id}/reconfigure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scopedBody),
        });
        if (!res.ok || !res.body) {
          const d = (await res.json().catch(() => null)) as { error?: string } | null;
          setPhase({ kind: "error", message: d?.error ?? `Request failed (${res.status}).` });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let total = 0;
        let done = 0;
        for (;;) {
          const { done: eof, value } = await reader.read();
          if (eof) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line) as IngestEvent;
            if (ev.type === "start") {
              total = ev.total;
              setPhase({ kind: "running", done: 0, total, file: "" });
            } else if (ev.type === "step") {
              setPhase({ kind: "running", done, total, file: ev.fileName });
            } else if (ev.type === "file-done") {
              done += 1;
              setPhase({ kind: "running", done, total, file: "" });
            } else if (ev.type === "done") {
              results.push(...ev.results);
            } else if (ev.type === "error") {
              setPhase({ kind: "error", message: ev.message });
              return;
            }
          }
        }
      }
      setPhase({ kind: "done", results });
      onDone();
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Network error." });
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {docScoped
            ? `Change settings for ${documentIds!.length === 1 ? "one document" : `${documentIds!.length} documents`}`
            : "Change this config"}
        </h2>

        <p className="text-xs text-zinc-500">
          {docScoped ? (
            <>
              Applies to{" "}
              <span className="font-mono">
                {(documentNames ?? []).join(", ")}
              </span>{" "}
              only, as per-chunk overrides — the config&apos;s own settings
              don&apos;t change. Re-score to see the effect on rates.
            </>
          ) : (
            <>
              Changes THIS config in place (no new config is created — use the tab
              bar&apos;s + or Duplicate for that). A model or chunk-size change
              re-embeds every document and re-points eval questions at the closest
              new chunk; scores go stale until the next re-score.
            </>
          )}
        </p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Embedding model</span>
          <select
            value={baseModel}
            onChange={(e) => setBaseModel(e.target.value)}
            disabled={busy || !models}
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          >
            {models?.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.selectable && m.id !== config.baseModel}>
                {m.label} ({m.dimension}d){m.id === config.baseModel ? " — current" : ""}
                {m.selectable ? "" : ` — ${m.reason}`}
              </option>
            ))}
          </select>
        </label>

        <div className={`grid gap-2 text-sm ${docScoped ? "grid-cols-2" : "grid-cols-3"}`}>
          <NumberField label="Chunk size" value={chunkSize} onChange={setChunkSize} disabled={busy} min={1} />
          <NumberField label="Overlap" value={chunkOverlap} onChange={setChunkOverlap} disabled={busy} min={0} />
          {!docScoped && (
            <NumberField label="Top-k" value={topK} onChange={setTopK} disabled={busy} min={1} />
          )}
        </div>

        {phase.kind === "running" && (
          <p className="text-xs text-zinc-500">
            {docScoped ? "Applying overrides…" : "Re-embedding…"} {phase.done}/{phase.total}
            {phase.file && ` · ${phase.file}`}
          </p>
        )}
        {phase.kind === "done" && (
          <div className="flex flex-col gap-0.5 text-xs">
            {phase.results.map((r, i) =>
              "error" in r ? (
                <span key={i} className="text-red-600 dark:text-red-400">
                  ✕ {r.fileName} — {r.error}
                </span>
              ) : (
                <span key={i} className="text-green-600 dark:text-green-400">
                  ✓ {r.fileName}
                </span>
              ),
            )}
            <span className="mt-1 text-zinc-500">
              Done. Re-score all to refresh Recall/nDCG under the new settings.
            </span>
          </div>
        )}
        {phase.kind === "error" && (
          <p className="text-sm text-red-600 dark:text-red-400">{phase.message}</p>
        )}
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
            {phase.kind === "done" ? "Close" : "Cancel"}
          </button>
          {phase.kind !== "done" && (
            <button
              type="button"
              onClick={submit}
              disabled={busy || Boolean(formError) || nothingChanged}
              title={nothingChanged ? "Nothing changed yet" : undefined}
              className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
            >
              {busy ? "Applying…" : "Apply"}
            </button>
          )}
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
