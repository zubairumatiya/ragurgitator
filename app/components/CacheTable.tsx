// UI: the /cache listing table (Client Component). Split out of the page — which
// stays a Server Component that reads the store — because rows expand, and that
// needs both state and measurement in the browser.
//
// Cells clamp to three lines and the ROW ITSELF toggles open — there is no
// chevron. A row only becomes clickable when its content is ACTUALLY cut off,
// which cannot be decided on the server: it depends on the rendered column
// width and the viewer's font. So each row measures itself (scrollHeight >
// clientHeight while clamped) and re-measures through a ResizeObserver, so rows
// gain and lose their affordance as the window resizes rather than having it
// decided once at mount. A row with nothing hidden is inert: no pointer cursor,
// no hover tint, no tab stop.
//
// Question and answer expand TOGETHER, off one control. They're two halves of
// one record, and independent toggles produced a row whose question was open
// while its answer was clipped — two clicks to read one exchange, and a ragged
// column of half-open cells.
//
// `import type` for the row shape: the type is erased at compile time, so this
// client module never pulls the server-only store chain behind it (same pattern
// as Sidebar's ConfigSummary import).
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CacheEntrySummary } from "@/lib/rag/semanticCache";

// Tailwind needs the literal class name, so the line count lives here rather
// than being interpolated.
const CLAMP = "line-clamp-3";
const CLAMPED = `${CLAMP} whitespace-pre-wrap`;
const EXPANDED = "whitespace-pre-wrap";

export function CacheTable({ entries }: { entries: CacheEntrySummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
            <th className="px-3 py-2 font-medium">Question</th>
            <th className="px-3 py-2 font-medium">Answer</th>
            <th className="px-3 py-2 font-medium">Answered by</th>
            <th className="px-3 py-2 font-medium">Banked by</th>
            <th className="px-3 py-2 text-right font-medium">Served</th>
            <th className="px-3 py-2 text-right font-medium">Last hit</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <CacheRow key={e.id} entry={e} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CacheRow({ entry }: { entry: CacheEntrySummary }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const questionRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  // Only meaningful while clamped: once expanded there is nothing to overflow,
  // so the check is skipped and `clipped` keeps its value — that's what leaves
  // the collapse control on screen for an open row.
  const measure = useCallback(() => {
    if (expanded) return;
    const overflowing = [questionRef, answerRef].some((ref) => {
      const el = ref.current;
      // +1 absorbs sub-pixel rounding: a cell that exactly fits can otherwise
      // report scrollHeight one pixel over and offer a no-op expand.
      return el !== null && el.scrollHeight > el.clientHeight + 1;
    });
    setClipped(overflowing);
  }, [expanded]);

  // Layout effect: measure before paint, so a clipped row never shows a frame
  // without its control.
  useLayoutEffect(measure, [measure]);

  // Re-measure on resize. Observing the cells catches column reflow (the table
  // is horizontally scrollable and columns are content-sized), which a window
  // listener alone would miss.
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (questionRef.current) observer.observe(questionRef.current);
    if (answerRef.current) observer.observe(answerRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const bodyClass = expanded ? EXPANDED : CLAMPED;

  // The ROW is the control — there is no button. A row only becomes interactive
  // once something in it is clipped; a fully-visible row stays inert, with no
  // pointer cursor and no tab stop, so nothing invites a click that would do
  // nothing.
  const interactive = clipped || expanded;

  const toggle = () => {
    // Don't fight text selection: these cells hold the question and answer
    // people came here to copy, and a drag that ends inside the row would
    // otherwise collapse it out from under the selection.
    if (window.getSelection()?.toString()) return;
    setExpanded((open) => !open);
  };

  return (
    <tr
      // aria-expanded is valid on role=row and is the reason this stays a <tr>
      // rather than becoming role="button": announcing it as a button would
      // throw away the row/column semantics a table reader depends on.
      aria-expanded={interactive ? expanded : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? toggle : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              // Space scrolls the page by default; Enter does nothing on a row.
              // Both are what people press on a focused expandable thing.
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            }
          : undefined
      }
      className={`border-b border-zinc-100 align-top last:border-0 dark:border-zinc-900 ${
        interactive
          ? "cursor-pointer transition-colors hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none dark:hover:bg-zinc-900/50 dark:focus-visible:bg-zinc-900/50"
          : ""
      }`}
    >
      <td className="max-w-xs px-3 py-2 font-medium text-black dark:text-zinc-100">
        <div ref={questionRef} className={bodyClass}>
          {entry.question}
        </div>
      </td>
      <td className="max-w-md px-3 py-2 text-zinc-600 dark:text-zinc-400">
        <div ref={answerRef} className={bodyClass}>
          {entry.answer}
        </div>
      </td>
      {/* The answering model, not the config, is what identifies an entry now
          that one entry is shared across every config of yours that holds the
          same documents (migration 0058). */}
      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
        <div className="truncate" title={`Keyed under ${entry.keyModel}`}>
          {entry.llmModel}
        </div>
      </td>
      {/* Provenance only — which config first paid for this answer. Any of your
          configs over the same documents can be served it, and it outlives the
          one that banked it. */}
      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
        {entry.configLabel === null ? (
          <span className="text-zinc-400" title="The config that banked this answer has been deleted">
            deleted config
          </span>
        ) : (
          <div className="truncate">{entry.configLabel}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
        {entry.hitCount === 0 ? <span className="text-zinc-400">—</span> : entry.hitCount}
      </td>
      <td className="px-3 py-2 text-right text-zinc-500 dark:text-zinc-400">
        {entry.lastHitAt === null ? (
          <span className="text-zinc-400">never</span>
        ) : (
          new Date(entry.lastHitAt).toLocaleDateString()
        )}
      </td>
    </tr>
  );
}
