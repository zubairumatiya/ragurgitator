// ---------------------------------------------------------------------------
// UI: lists documents currently in the (pgvector) store, with per-document
// delete.
//
// Fetches on mount and re-fetches when FileUpload dispatches the
// `rag:ingested` window event after a successful upload, or after a delete
// here. Deleting a document removes its chunks and eval data (FK cascade).
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import type { IngestedDocument } from "@/lib/rag/vectorStore";

export const RAG_INGESTED_EVENT = "rag:ingested";

export function DocumentList() {
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Bump to re-fetch (after an ingest event or a delete). Mirrors EvalDashboard.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const res = await fetch("/api/documents");
        const data = (await res.json()) as
          | { documents: IngestedDocument[] }
          | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setError("error" in data ? data.error : `Request failed (${res.status}).`);
          return;
        }
        setError(null);
        setDocs(data.documents);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Network error.");
      }
    }

    load();
    const onChanged = () => setReloadKey((k) => k + 1);
    window.addEventListener(RAG_INGESTED_EVENT, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(RAG_INGESTED_EVENT, onChanged);
    };
  }, [reloadKey]);

  async function remove(doc: IngestedDocument) {
    const confirmed = window.confirm(
      `Delete "${doc.fileName}"? This removes its ${doc.chunkCount} chunk` +
        `${doc.chunkCount === 1 ? "" : "s"} and any eval questions/results for it. ` +
        `This can't be undone.`,
    );
    if (!confirmed) return;

    setDeletingId(doc.id);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setDeletingId(null);
    }
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (docs === null) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }
  if (docs.length === 0) {
    return <p className="text-sm text-zinc-500">No documents ingested yet.</p>;
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800">
      {docs.map((d) => (
        <li
          key={d.id}
          className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
        >
          <span className="truncate font-mono">{d.fileName}</span>
          <span className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-zinc-500">
              {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
            </span>
            <button
              onClick={() => remove(d)}
              disabled={deletingId === d.id}
              className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              {deletingId === d.id ? "Deleting…" : "Delete"}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
