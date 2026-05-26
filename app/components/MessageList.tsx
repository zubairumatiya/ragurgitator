// ---------------------------------------------------------------------------
// UI: renders the list of chat messages.
//
// Pure presentation — props in, JSX out. Assistant messages can carry their
// retrieved sources so you can see which chunks the model leaned on.
// ---------------------------------------------------------------------------
"use client";

import { useState } from "react";
import type { ChatMessage, RetrievedChunk } from "@/types/rag";

export type DisplayMessage = ChatMessage & {
  sources?: RetrievedChunk[];
  pending?: boolean;
};

export function MessageList({ messages }: { messages: DisplayMessage[] }) {
  if (messages.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Ask a question about the documents you ingested.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {messages.map((m, i) => (
        <li
          key={i}
          className={`flex flex-col gap-2 ${
            m.role === "user" ? "items-end" : "items-start"
          }`}
        >
          <div
            className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
              m.role === "user"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            }`}
          >
            {m.pending ? (
              <span className="italic text-zinc-500">Thinking…</span>
            ) : (
              m.content
            )}
          </div>

          {m.role === "assistant" && m.sources && m.sources.length > 0 && (
            <details className="w-full max-w-[85%] text-xs text-zinc-600 dark:text-zinc-400">
              <summary className="cursor-pointer select-none">
                {m.sources.length} source
                {m.sources.length === 1 ? "" : "s"}
              </summary>
              <ol className="mt-2 flex flex-col gap-2">
                {m.sources.map((s, j) => (
                  <SourceCard key={j} source={s} />
                ))}
              </ol>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function SourceCard({ source }: { source: RetrievedChunk }) {
  const [expanded, setExpanded] = useState(false);
  const { chunk } = source.chunk;

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left rounded border border-zinc-200 dark:border-zinc-800 p-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer"
      >
        <div className="font-mono text-[11px] text-zinc-500">
          <div className="truncate">{chunk.documentId}</div>
          <div className="mt-0.5 flex justify-between gap-2">
            <span>position {chunk.position}</span>
            <span>score {source.score.toFixed(3)}</span>
          </div>
        </div>
        <p
          className={`mt-1 whitespace-pre-wrap ${
            expanded ? "" : "line-clamp-4"
          }`}
        >
          {chunk.text}
        </p>
      </button>
    </li>
  );
}
