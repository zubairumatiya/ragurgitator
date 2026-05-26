// ---------------------------------------------------------------------------
// UI: upload / paste documents to ingest (Client Component).
//
// Submits to /api/ingest as multipart/form-data and shows the result count.
// Uses React 19's <form action={...}> pattern, which hands us a FormData
// directly and avoids the deprecated synthetic-event types.
// ---------------------------------------------------------------------------
"use client";

import { useState } from "react";
import { RAG_INGESTED_EVENT } from "@/app/components/DocumentList";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; chunksAdded: number; label: string }
  | { kind: "error"; message: string };

export function FileUpload() {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);

  async function action(form: FormData) {
    let label: string;

    if (mode === "file") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        setStatus({ kind: "error", message: "Pick a file first." });
        return;
      }
      label = file.name;
      // form already has the file; strip the text field so the server doesn't
      // see both at once.
      form.delete("text");
    } else {
      const text = form.get("text");
      if (typeof text !== "string" || !text.trim()) {
        setStatus({ kind: "error", message: "Paste some text first." });
        return;
      }
      const fileName = form.get("fileName");
      label = typeof fileName === "string" && fileName.trim() ? fileName.trim() : "pasted-text";
      form.delete("file");
    }

    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const data = (await res.json()) as
        | { chunksAdded: number }
        | { error: string };
      if (!res.ok || "error" in data) {
        const message = "error" in data ? data.error : `Request failed (${res.status}).`;
        setStatus({ kind: "error", message });
        return;
      }
      setStatus({ kind: "success", chunksAdded: data.chunksAdded, label });
      setPickedFileName(null);
      window.dispatchEvent(new Event(RAG_INGESTED_EVENT));
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  const disabled = status.kind === "loading";

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
    >
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("file")}
          className={`rounded px-3 py-1 ${
            mode === "file"
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
              : "bg-zinc-100 dark:bg-zinc-800"
          }`}
        >
          File
        </button>
        <button
          type="button"
          onClick={() => setMode("text")}
          className={`rounded px-3 py-1 ${
            mode === "text"
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
              : "bg-zinc-100 dark:bg-zinc-800"
          }`}
        >
          Paste text
        </button>
      </div>

      {mode === "file" ? (
        <label
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center text-sm transition-colors ${
            disabled
              ? "border-zinc-200 dark:border-zinc-800 opacity-60 cursor-not-allowed"
              : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-500 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer"
          }`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-8 w-8 text-zinc-400"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16.5V9m0 0-3 3m3-3 3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z"
            />
          </svg>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {pickedFileName ?? "Click to choose a file"}
          </span>
          <span className="text-xs text-zinc-500">
            .txt, .md, .pdf, or .docx
          </span>
          <input
            type="file"
            name="file"
            accept=".txt,.md,.pdf,.docx"
            disabled={disabled}
            onChange={(e) => setPickedFileName(e.target.files?.[0]?.name ?? null)}
            className="sr-only"
          />
        </label>
      ) : (
        <>
          <input
            type="text"
            name="fileName"
            placeholder="Optional source name (e.g. 'meeting-notes')"
            disabled={disabled}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
          />
          <textarea
            name="text"
            disabled={disabled}
            placeholder="Paste document text here..."
            rows={8}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 text-sm font-mono"
          />
        </>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
      >
        {disabled ? "Ingesting…" : "Ingest"}
      </button>

      {status.kind === "success" && (
        <p className="text-sm text-green-600 dark:text-green-400">
          Added {status.chunksAdded} chunk{status.chunksAdded === 1 ? "" : "s"} from{" "}
          <span className="font-mono">{status.label}</span>.
        </p>
      )}
      {status.kind === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{status.message}</p>
      )}
    </form>
  );
}
