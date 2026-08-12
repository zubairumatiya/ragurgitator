// UI: renders the list of chat messages.
//
// Pure presentation — props in, JSX out. Assistant messages can carry their
// retrieved sources so you can see which chunks the model leaned on.
"use client";

import { Fragment, useState } from "react";
import type { ChatMessage, RetrievedChunk } from "@/types/rag";

export type DisplayMessage = ChatMessage & {
  sources?: RetrievedChunk[];
  // documentId → file name, for the source cards. Per-message because it
  // travels with the response that produced those sources (POST /api/chat).
  documents?: Record<string, string>;
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
              <Thinking />
            ) : m.role === "assistant" ? (
              <Formatted text={m.content} />
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
                  <SourceCard key={j} source={s} documents={m.documents} />
                ))}
              </ol>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

// The two bits of Markdown a model reaches for by habit — **bold** and "- " / "* "
// bullets — rendered rather than printed. The system prompt asks for plain prose;
// this is what happens when a model ignores it.
//
// Deliberately NOT a Markdown library: the input is untrusted model output, and a
// full renderer is a much bigger surface (raw HTML passthrough, links, images) for
// two marks. Everything here builds React nodes from string slices, so nothing is
// ever interpreted as markup, and anything unrecognised falls through as the literal
// text it already was.
//
// Everything stays INLINE and the "\n" characters are kept: the bubble is
// whitespace-pre-wrap, so the newlines are already the line breaks. A block-level row
// per line would lay out beside them and double-space the whole answer.
function Formatted({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        return (
          <Fragment key={i}>
            {bullet ? `• ` : ""}
            {bold(bullet ? bullet[1] : line)}
            {i < lines.length - 1 && "\n"}
          </Fragment>
        );
      })}
    </>
  );
}

// **…** → <strong>. Splitting on the delimiter leaves the emphasised pieces at
// the ODD indices — but only when every marker is paired, which is exactly when
// the split yields an odd number of parts. An unpaired ** (an even count) means
// the line is something else, so it's returned untouched rather than having the
// rest of the answer bolded by a stray marker.
function bold(line: string) {
  const parts = line.split("**");
  if (parts.length < 3 || parts.length % 2 === 0) return line;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

// The pending bubble. Reads as "sending" rather than as a word someone typed:
// the dots move, so the difference between "working" and "stuck" is visible
// without the user having to remember what the bubble said a second ago.
function Thinking() {
  return (
    <span className="flex items-center gap-1.5 text-zinc-500" role="status">
      <span className="italic">Thinking</span>
      <span aria-hidden className="flex gap-0.5">
        <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
      </span>
    </span>
  );
}

function SourceCard({
  source,
  documents,
}: {
  source: RetrievedChunk;
  documents?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { chunk } = source.chunk;
  // "notes.pdf · chunk #3" — the same label the eval and autotune panels use, so
  // a chunk is named identically everywhere. Falls back to the id when the map
  // has no entry (a document deleted between answering and rendering): a UUID is
  // poor, but silently unlabelled sources would be worse.
  const fileName = documents?.[chunk.documentId];

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left rounded border border-zinc-200 dark:border-zinc-800 p-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer"
      >
        <div className="font-mono text-[11px] text-zinc-500">
          <div className="truncate">
            {fileName ?? chunk.documentId} · chunk #{chunk.position}
          </div>
          <div className="mt-0.5 flex justify-end gap-2">
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
