// UI: lists documents currently in the (pgvector) store, with per-document delete.
//
// Fetches on mount and re-fetches when FileUpload dispatches the `rag:ingested`
// window event after a successful upload, or after a delete here.
//
// Remove is scoped to the ACTIVE CONFIG — this config's chunks for the document and
// the eval LABELS that point at them, and nothing else. The document stays in the
// user's library, every other config keeps its own copy, and the eval QUESTIONS stay
// too: those are per-document by design (0002), so one question bank serves every
// config. The confirm text spells it out because a "Delete" next to a file name
// reads as "delete the file" — which is why this button says Remove.
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/http/client";
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
        const res = await apiFetch("/api/documents");
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
      `Remove "${doc.fileName}" from this config? This deletes its ` +
        `${doc.chunkCount} chunk${doc.chunkCount === 1 ? "" : "s"} here, and the ` +
        `ground-truth labels pointing at them. Other configs keep their copy, ` +
        `your eval questions for this document stay (they're shared across ` +
        `configs), and the file stays in your library — you can re-embed it ` +
        `without re-uploading. This can't be undone.`,
    );
    if (!confirmed) return;

    setDeletingId(doc.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/documents/${doc.id}`, { method: "DELETE" });
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
              className="cursor-pointer text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
            >
              {deletingId === d.id ? "Removing…" : "Remove"}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
