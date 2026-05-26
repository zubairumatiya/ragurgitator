// ---------------------------------------------------------------------------
// UI: lists documents currently in the in-memory vector store.
//
// Fetches on mount and re-fetches when FileUpload dispatches the
// `rag:ingested` window event after a successful upload.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import type { IngestedDocument } from "@/lib/rag/vectorStore";

export const RAG_INGESTED_EVENT = "rag:ingested";

export function DocumentList() {
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    window.addEventListener(RAG_INGESTED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(RAG_INGESTED_EVENT, load);
    };
  }, []);

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
          <span className="shrink-0 text-xs text-zinc-500">
            {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}
