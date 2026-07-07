// ---------------------------------------------------------------------------
// UI: a corpus's document manager (Client Component) on /corpora/[id].
//
//   - member docs table with per-doc Remove (membership only; auto-synced
//     configs also lose that doc's chunks — the confirm says so)
//   - add EXISTING global documents (checkbox picker)
//   - upload NEW files into the corpus
//
// Adds POST /api/corpora/[id]/documents and stream IngestEvents: when the
// corpus has auto-synced configs the docs are embedded into each one (real
// cost, so real progress); with none the stream finishes instantly. After any
// mutation: router.refresh() + CORPORA_CHANGED for the sidebar.
// ---------------------------------------------------------------------------
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CORPORA_CHANGED } from "@/app/components/Sidebar";
import { apiFetch } from "@/lib/http/client";
import type { CorpusDocument } from "@/lib/rag/corpusStore";
import type { IngestEvent } from "@/lib/rag/pipeline";

type Progress = { done: number; total: number; file: string } | null;

export function CorpusDocsPanel({
  corpusId,
  documents,
  availableDocuments,
  syncedCount,
}: {
  corpusId: string;
  documents: CorpusDocument[];
  availableDocuments: CorpusDocument[];
  syncedCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  function refreshAll() {
    window.dispatchEvent(new Event(CORPORA_CHANGED));
    router.refresh();
  }

  // Consume the add-documents NDJSON stream (same IngestEvents as ingest).
  async function runAddStream(res: Response) {
    if (!res.ok || !res.body) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? `Add failed (${res.status}).`);
      return false;
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
        if (ev.type === "start") {
          total = ev.total;
          if (total > 0) setProgress({ done: 0, total, file: "" });
        } else if (ev.type === "step") {
          setProgress({ done, total, file: ev.fileName });
        } else if (ev.type === "file-done") {
          done += 1;
          setProgress({ done, total, file: "" });
        } else if (ev.type === "error") {
          setError(ev.message);
          return false;
        }
      }
    }
    return true;
  }

  async function addExisting() {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const res = await apiFetch(`/api/corpora/${corpusId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: picked }),
      });
      if (await runAddStream(res)) {
        setPicked([]);
        setPickerOpen(false);
        refreshAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const res = await apiFetch(`/api/corpora/${corpusId}/documents`, {
        method: "POST",
        body: form,
      });
      if (await runAddStream(res)) refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeDoc(doc: CorpusDocument) {
    const syncNote =
      syncedCount > 0
        ? `\n\nAlso removes its chunks from ${syncedCount} auto-synced config(s). ` +
          "Other configs keep it."
        : "";
    if (!window.confirm(`Remove "${doc.fileName}" from this corpus?${syncNote}`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/corpora/${corpusId}/documents/${doc.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Remove failed (${res.status}).`);
        return;
      }
      refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <section className="flex flex-col gap-3">
      {/* Add controls */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".txt,.md,.pdf,.docx"
          className="hidden"
          onChange={(e) => uploadFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          Upload files…
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          disabled={busy || availableDocuments.length === 0}
          title={
            availableDocuments.length === 0
              ? "Every existing document is already in this corpus"
              : "Add documents that already exist in the app"
          }
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
        >
          Add existing documents{availableDocuments.length > 0 && ` (${availableDocuments.length})`}
        </button>
        {syncedCount > 0 && (
          <span className="text-xs text-zinc-400">
            additions embed into {syncedCount} synced config{syncedCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {pickerOpen && (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
            {availableDocuments.map((d) => (
              <label
                key={d.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(d.id)}
                  onChange={() => togglePick(d.id)}
                  disabled={busy}
                />
                <span className="truncate text-zinc-700 dark:text-zinc-300">
                  {d.fileName}
                </span>
                {!d.hasContent && (
                  <span
                    className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-500"
                    title="Uploaded before raw text was stored — can't be embedded into synced/new configs without re-uploading"
                  >
                    no stored text
                  </span>
                )}
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={addExisting}
            disabled={busy || picked.length === 0}
            className="self-start rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
          >
            Add selected ({picked.length})
          </button>
        </div>
      )}

      {progress && progress.total > 0 && (
        <p className="text-xs text-zinc-500">
          Embedding into synced configs… {progress.done}/{progress.total}
          {progress.file && ` · ${progress.file}`}
        </p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Member documents */}
      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No documents yet. Upload files, add existing documents, or let a synced
          config&apos;s uploads land here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 text-right font-medium">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-900"
                >
                  <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">
                    {d.fileName}
                    {!d.hasContent && (
                      <span
                        className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-500"
                        title="Uploaded before raw text was stored — can't be re-embedded into new configs without re-uploading"
                      >
                        no stored text
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-zinc-500">
                    {new Date(d.addedAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeDoc(d)}
                      disabled={busy}
                      title="Remove from this corpus (the document itself stays in the app)"
                      className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950 dark:hover:text-red-400"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
