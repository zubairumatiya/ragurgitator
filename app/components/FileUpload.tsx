// ---------------------------------------------------------------------------
// UI: upload / paste documents to ingest (Client Component).
//
// Submits to /api/ingest as multipart/form-data and shows a per-source result.
// Multiple files can be selected at once; each is reported independently so one
// bad file doesn't hide the rest. Uses React 19's <form action={...}> pattern,
// which hands us a FormData directly and avoids deprecated synthetic-event types.
// ---------------------------------------------------------------------------
"use client";

import { useState } from "react";
import { RAG_INGESTED_EVENT } from "@/app/components/DocumentList";
import { apiFetch } from "@/lib/http/client";
import { config } from "@/lib/config";
import type { IngestEvent, IngestResult, IngestStep } from "@/lib/rag/pipeline";

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The pipeline's stages, in order — used both for the step indicator and to map
// the current step to an overall completion fraction.
const STEPS: { key: IngestStep; label: string }[] = [
  { key: "load", label: "Load" },
  { key: "chunk", label: "Chunk" },
  { key: "embed", label: "Embed" },
  { key: "store", label: "Store" },
];

type Picked = { names: string[]; totalBytes: number };

// Live ingestion progress, rebuilt from the streamed events.
type Progress = {
  total: number;
  completedFiles: number;
  index: number;
  fileName: string;
  step: IngestStep;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading"; progress: Progress | null }
  | { kind: "done"; results: IngestResult[] }
  | { kind: "error"; message: string };

export function FileUpload() {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [picked, setPicked] = useState<Picked | null>(null);

  // Client-side pre-flight: block oversized batches before uploading, and grey
  // out the Ingest button so the limit is visible rather than a surprise 413.
  const oversize =
    mode === "file" && picked !== null && picked.totalBytes > config.maxUploadBytes;

  async function action(form: FormData) {
    if (mode === "file") {
      const files = form
        .getAll("file")
        .filter((f): f is File => f instanceof File && f.size > 0);
      if (files.length === 0) {
        setStatus({ kind: "error", message: "Pick at least one file first." });
        return;
      }
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > config.maxUploadBytes) {
        setStatus({
          kind: "error",
          message: `Upload too large: ${formatMB(totalBytes)} across ${files.length} file(s). Max is ${formatMB(config.maxUploadBytes)}.`,
        });
        return;
      }
      // form already has the files; strip the text field so the server doesn't
      // see both at once.
      form.delete("text");
    } else {
      const text = form.get("text");
      if (typeof text !== "string" || !text.trim()) {
        setStatus({ kind: "error", message: "Paste some text first." });
        return;
      }
      form.delete("file");
    }

    setStatus({ kind: "loading", progress: null });
    try {
      const res = await apiFetch("/api/ingest", { method: "POST", body: form });

      // Validation failures (400/413/500) come back as plain JSON, not a stream.
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus({
          kind: "error",
          message: data?.error ?? `Request failed (${res.status}).`,
        });
        return;
      }

      // Success path: read the NDJSON event stream and drive the progress UI.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let total = 0;
      let completedFiles = 0;
      let results: IngestResult[] = [];

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the trailing partial line
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as IngestEvent;
          switch (event.type) {
            case "start":
              total = event.total;
              break;
            case "step":
              setStatus({
                kind: "loading",
                progress: {
                  total,
                  completedFiles,
                  index: event.index,
                  fileName: event.fileName,
                  step: event.step,
                },
              });
              break;
            case "file-done":
              completedFiles += 1;
              break;
            case "done":
              results = event.results;
              break;
            case "error":
              setStatus({ kind: "error", message: event.message });
              return;
          }
        }
      }

      setStatus({ kind: "done", results });
      setPicked(null);
      // Refresh the document list if at least one source landed without error.
      if (results.some((r) => !("error" in r))) {
        window.dispatchEvent(new Event(RAG_INGESTED_EVENT));
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  const loading = status.kind === "loading";

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
    >
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("file")}
          disabled={loading}
          className={`rounded px-3 py-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
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
          disabled={loading}
          className={`rounded px-3 py-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
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
            loading
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
            {picked
              ? picked.names.length === 1
                ? picked.names[0]
                : `${picked.names.length} files selected`
              : "Click to choose files"}
          </span>
          <span className="text-xs text-zinc-500">
            .txt, .md, .pdf, or .docx — pick one or more (max {formatMB(config.maxUploadBytes)} total)
          </span>
          <input
            type="file"
            name="file"
            accept=".txt,.md,.pdf,.docx"
            multiple
            disabled={loading}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              setPicked(
                files.length
                  ? {
                      names: files.map((f) => f.name),
                      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
                    }
                  : null,
              );
            }}
            className="sr-only"
          />
        </label>
      ) : (
        <>
          <input
            type="text"
            name="fileName"
            placeholder="Optional source name (e.g. 'meeting-notes')"
            disabled={loading}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm"
          />
          <textarea
            name="text"
            disabled={loading}
            placeholder="Paste document text here..."
            rows={8}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 text-sm font-mono"
          />
        </>
      )}

      {oversize && picked && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Files total {formatMB(picked.totalBytes)} — max is{" "}
          {formatMB(config.maxUploadBytes)}. Remove some before ingesting.
        </p>
      )}

      <button
        type="submit"
        disabled={loading || oversize}
        className="inline-flex items-center gap-2 self-start rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
      >
        {loading && (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4 animate-spin"
            fill="none"
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {loading ? "Ingesting…" : "Ingest"}
      </button>

      {status.kind === "loading" && <IngestProgress progress={status.progress} />}
      {status.kind === "done" && <IngestSummary results={status.results} />}
      {status.kind === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{status.message}</p>
      )}
    </form>
  );
}

// Live progress: an overall bar plus a Load → Chunk → Embed → Store indicator
// that reflects the in-flight file's current stage.
function IngestProgress({ progress }: { progress: Progress | null }) {
  const activeOrdinal = progress
    ? STEPS.findIndex((s) => s.key === progress.step)
    : -1;
  // Finished files dominate the bar; the in-flight file adds a partial slice
  // based on which of its 4 stages is running. `done` then fills it to 100%.
  const fraction = progress
    ? Math.min(1, (progress.completedFiles + activeOrdinal / STEPS.length) / progress.total)
    : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="truncate">
          {progress
            ? progress.total > 1
              ? `File ${progress.index + 1} of ${progress.total} · ${progress.fileName}`
              : progress.fileName
            : "Starting…"}
        </span>
        <span className="tabular-nums">{percent}%</span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-300 dark:bg-zinc-100"
          style={{ width: `${Math.max(percent, 4)}%` }}
        />
      </div>

      <div className="flex gap-1.5">
        {STEPS.map((s, i) => {
          const state =
            activeOrdinal === -1
              ? "pending"
              : i < activeOrdinal
                ? "done"
                : i === activeOrdinal
                  ? "active"
                  : "pending";
          return (
            <span
              key={s.key}
              className={`flex-1 rounded px-2 py-1 text-center text-xs transition-colors ${
                state === "done"
                  ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                  : state === "active"
                    ? "animate-pulse bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                    : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
              }`}
            >
              {s.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Per-source breakdown: one line each, green for ingested, red for failures.
function IngestSummary({ results }: { results: IngestResult[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {results.map((r, i) =>
        "error" in r ? (
          <li key={i} className="text-red-600 dark:text-red-400">
            ✕ <span className="font-mono">{r.fileName}</span> — {r.error}
          </li>
        ) : (
          <li key={i} className="text-green-600 dark:text-green-400">
            ✓ <span className="font-mono">{r.fileName}</span> —{" "}
            {r.chunksAdded > 0
              ? `${r.chunksAdded} chunk${r.chunksAdded === 1 ? "" : "s"}`
              : "no new chunks"}
          </li>
        ),
      )}
    </ul>
  );
}
