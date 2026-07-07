// ---------------------------------------------------------------------------
// UI: delete-a-corpus button (Client Component), used on the corpora list and
// detail pages. Deleting a corpus never deletes configs: any attached config
// keeps its embedded documents — its corpus pointer clears and auto-sync
// breaks (0017). The confirm spells that out. On success: sidebar refresh via
// CORPORA_CHANGED, router.refresh(), and optional redirect (detail page).
// ---------------------------------------------------------------------------
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CORPORA_CHANGED } from "@/app/components/Sidebar";
import { apiFetch } from "@/lib/http/client";

export function CorpusDeleteButton({
  corpusId,
  name,
  attachedConfigs,
  redirectTo,
}: {
  corpusId: string;
  name: string;
  attachedConfigs: number;
  redirectTo?: string; // set on the detail page (the page is about to vanish)
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const configNote =
      attachedConfigs > 0
        ? `\n\n${attachedConfigs} config(s) point at it — they keep all their ` +
          "documents; only the link (and auto-sync) breaks."
        : "";
    if (!window.confirm(`Delete corpus "${name}"?${configNote}`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/corpora/${corpusId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Delete failed (${res.status}).`);
        return;
      }
      window.dispatchEvent(new Event(CORPORA_CHANGED));
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        title="Delete this corpus (configs keep their documents)"
        className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950 dark:hover:text-red-400"
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
