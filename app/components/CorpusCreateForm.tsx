// ---------------------------------------------------------------------------
// UI: "New corpus" form (Client Component) on the corpora page. Creates an
// empty corpus, or — with "start from existing corpora" checked — a merged one
// seeded with the selection's documents, de-duplicated by content hash (the
// CorpusPicker previews the union and warns on duplicates). POSTs
// /api/corpora, then router.refresh()es the server-rendered list and fires
// CORPORA_CHANGED so the sidebar re-pulls too.
// ---------------------------------------------------------------------------
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CorpusPicker } from "@/app/components/CorpusPicker";
import { CORPORA_CHANGED } from "@/app/components/Sidebar";
import { apiFetch } from "@/lib/http/client";
import type { CorpusSummary } from "@/lib/rag/corpusStore";

export function CorpusCreateForm({ corpora }: { corpora: CorpusSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [fromExisting, setFromExisting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/corpora", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          fromCorpusIds: fromExisting ? selected : [],
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Create failed (${res.status}).`);
        return;
      }
      setName("");
      setSelected([]);
      setFromExisting(false);
      window.dispatchEvent(new Event(CORPORA_CHANGED));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={busy}
          placeholder="New corpus name…"
          className="w-64 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !name.trim()}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={fromExisting}
          onChange={(e) => setFromExisting(e.target.checked)}
          disabled={busy || corpora.length === 0}
        />
        Start from existing corpora
        {corpora.length === 0 && (
          <span className="text-xs text-zinc-400">(none yet)</span>
        )}
      </label>

      {fromExisting && (
        <CorpusPicker
          corpora={corpora}
          selected={selected}
          onChange={setSelected}
          disabled={busy}
        />
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
