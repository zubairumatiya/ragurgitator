// ---------------------------------------------------------------------------
// UI: corpus multi-select with duplicate detection (Client Component), shared
// by the create-config dialog and the corpora page's create-from form.
//
// Renders a checkbox per corpus; as corpora are selected it lazily fetches each
// one's documents (GET /api/corpora/[id]) and reports the selection's de-duped
// union: the same document in several corpora counts once, and distinct
// document rows with the SAME content hash (the same file uploaded twice) are
// collapsed — surfaced as the yellow "duplicate docs detected" warning, with
// the underlined phrase carrying a hover tooltip that lists the dupes.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/http/client";
import type { CorpusDocument, CorpusSummary } from "@/lib/rag/corpusStore";

export type DupeGroup = { kept: string; dropped: string[] };

export type SelectionPreview = {
  loading: boolean;
  uniqueDocs: number;
  dupes: DupeGroup[];
};

// Mirror of corpusStore.dedupCorporaDocuments for the client-side preview:
// union by document id, then collapse by content hash (prefer a doc with
// stored text, then the earliest).
function previewFor(
  selected: string[],
  docsByCorpus: Map<string, CorpusDocument[]>,
): SelectionPreview {
  const lists = selected.map((id) => docsByCorpus.get(id));
  if (lists.some((l) => l === undefined)) {
    return { loading: true, uniqueDocs: 0, dupes: [] };
  }
  const byId = new Map<string, CorpusDocument>();
  for (const list of lists as CorpusDocument[][]) {
    for (const d of list) byId.set(d.id, d);
  }
  const byHash = new Map<string, CorpusDocument[]>();
  for (const d of byId.values()) {
    const group = byHash.get(d.contentHash) ?? [];
    group.push(d);
    byHash.set(d.contentHash, group);
  }
  const dupes: DupeGroup[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) => Number(b.hasContent) - Number(a.hasContent) || a.addedAt - b.addedAt,
    );
    dupes.push({ kept: group[0].fileName, dropped: group.slice(1).map((g) => g.fileName) });
  }
  return { loading: false, uniqueDocs: byHash.size, dupes };
}

export function CorpusPicker({
  corpora,
  selected,
  onChange,
  disabled,
  onPreview,
}: {
  corpora: CorpusSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  // Parent gets the live preview (unique doc count) if it wants to gate submit.
  onPreview?: (p: SelectionPreview) => void;
}) {
  const [docsByCorpus, setDocsByCorpus] = useState<Map<string, CorpusDocument[]>>(
    new Map(),
  );

  // Fetch each newly-selected corpus's docs once; keep the cache for the
  // session so toggling back and forth is free.
  useEffect(() => {
    const missing = selected.filter((id) => !docsByCorpus.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (id) => {
        const res = await apiFetch(`/api/corpora/${id}`);
        const data = (await res.json().catch(() => null)) as
          | { documents?: CorpusDocument[] }
          | null;
        return [id, data?.documents ?? []] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setDocsByCorpus((m) => {
        const next = new Map(m);
        for (const [id, docs] of pairs) next.set(id, docs);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [selected, docsByCorpus]);

  const preview = useMemo(
    () => previewFor(selected, docsByCorpus),
    [selected, docsByCorpus],
  );
  useEffect(() => {
    onPreview?.(preview);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on preview change only
  }, [preview]);

  function toggle(id: string) {
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded border border-zinc-200 p-1.5 dark:border-zinc-800">
        {corpora.length === 0 && (
          <span className="px-1 py-0.5 text-xs text-zinc-400">No corpora yet.</span>
        )}
        {corpora.map((c) => (
          <label
            key={c.id}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={() => toggle(c.id)}
              disabled={disabled}
            />
            <span className="truncate text-zinc-700 dark:text-zinc-300">{c.name}</span>
            <span className="ml-auto shrink-0 text-xs text-zinc-400">
              {c.docCount === 0 ? "empty" : `${c.docCount} doc${c.docCount === 1 ? "" : "s"}`}
            </span>
          </label>
        ))}
      </div>

      {selected.length > 0 && !preview.loading && (
        <span className="text-xs text-zinc-500">
          {preview.uniqueDocs} unique doc{preview.uniqueDocs === 1 ? "" : "s"} selected
          {preview.dupes.length > 0 && (
            <>
              {" — "}
              <span
                className="cursor-help font-medium text-amber-600 underline decoration-dotted dark:text-amber-500"
                title={preview.dupes
                  .map((d) => `"${d.kept}" kept — duplicate of: ${d.dropped.map((x) => `"${x}"`).join(", ")}`)
                  .join("\n")}
              >
                duplicate docs detected
              </span>{" "}
              <span className="text-amber-600 dark:text-amber-500">
                (auto de-duplicated)
              </span>
            </>
          )}
        </span>
      )}
      {selected.length > 0 && preview.loading && (
        <span className="text-xs text-zinc-400">Checking selection…</span>
      )}
    </div>
  );
}
