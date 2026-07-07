// ---------------------------------------------------------------------------
// UI: the cross-config tab bar (Client Component) that sits above every config
// page — the top row in the §6 shell:
//
//   [ Resume-v1 × ] [ Resume-v2 × ] [ + ] [ ⌄ saved ]        [ 📊 Appraise ]
//
// Open configs are tabs (active highlighted); each has a small ⋯ menu for
// Duplicate / Rename / Close. "+" creates a new empty config and routes to it.
// "⌄ saved" reopens a closed config. "📊 Appraise" is a pinned, cross-config view
// (a stub for now). The initial lists come from the server layout as props; after
// any mutation we router.refresh() to re-pull them, and route as needed.
//
// Styling mirrors Nav.tsx / EvalDashboard.tsx (zinc palette, rounded, subtle).
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfigCreateDialog } from "@/app/components/ConfigCreateDialog";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";

export function ConfigTabs({
  open,
  closed,
  activeId,
}: {
  open: ConfigSummary[];
  closed: ConfigSummary[];
  activeId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null); // which tab's ⋯ menu is open
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [savedOpen, setSavedOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Run a mutation, surface its error, then refresh the server-provided lists.
  // `after` optionally navigates (e.g. to a freshly created/duplicated tab).
  async function mutate(
    run: () => Promise<Response>,
    after?: (data: unknown) => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      after?.(data);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
      setMenuId(null);
    }
  }

  function gotoConfig(id: string) {
    router.push(`/c/${id}`);
  }

  async function duplicate(id: string) {
    await mutate(
      () => apiFetch(`/api/configs/${id}`, { method: "POST" }),
      (data) => {
        const created = (data as { config?: ConfigSummary } | null)?.config;
        if (created) gotoConfig(created.id);
      },
    );
  }

  async function close(id: string) {
    // If closing the active tab, hop to another open one first.
    const fallback = open.find((c) => c.id !== id);
    await mutate(
      () => apiFetch(`/api/configs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isOpen: false }),
      }),
      () => {
        if (id === activeId && fallback) gotoConfig(fallback.id);
      },
    );
  }

  async function reopen(id: string) {
    setSavedOpen(false);
    await mutate(
      () => apiFetch(`/api/configs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isOpen: true }),
      }),
      () => gotoConfig(id),
    );
  }

  async function submitRename(id: string) {
    const name = renameText.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    await mutate(() =>
      apiFetch(`/api/configs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
    setRenamingId(null);
  }

  const canClose = open.length > 1;

  return (
    <div className="flex flex-col gap-1 border-b border-zinc-200 bg-zinc-50 px-4 pt-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-end justify-between gap-3">
        {/* Left: open config tabs + new + reopen */}
        <div className="flex flex-wrap items-center gap-1">
          {open.map((cfg) => {
            const active = cfg.id === activeId;
            return (
              <div
                key={cfg.id}
                className={`group relative flex items-center gap-1 rounded-t-md border px-3 py-1.5 text-sm ${
                  active
                    ? "border-zinc-200 border-b-transparent bg-white font-medium text-zinc-900 dark:border-zinc-800 dark:bg-black dark:text-zinc-50"
                    : "border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
                }`}
              >
                {renamingId === cfg.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => submitRename(cfg.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename(cfg.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-28 rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-sm dark:border-zinc-600"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => gotoConfig(cfg.id)}
                    title={`${cfg.label} · ${cfg.baseModel} · ${cfg.chunkSize}/${cfg.chunkOverlap} · corpus: ${cfg.corpusName ?? "none"}`}
                    className="cursor-pointer truncate max-w-[12rem]"
                  >
                    {cfg.label}
                  </button>
                )}

                {/* ⋯ menu: Duplicate / Rename / Close */}
                <button
                  type="button"
                  onClick={() => setMenuId((m) => (m === cfg.id ? null : cfg.id))}
                  disabled={busy}
                  title="Tab actions"
                  className="cursor-pointer rounded px-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  ⋯
                </button>

                {menuId === cfg.id && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                    <div className="absolute left-0 top-full z-20 mt-1 w-36 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                      <MenuItem onClick={() => duplicate(cfg.id)}>Duplicate</MenuItem>
                      <MenuItem
                        onClick={() => {
                          setMenuId(null);
                          setRenamingId(cfg.id);
                          setRenameText(cfg.name ?? "");
                        }}
                      >
                        Rename
                      </MenuItem>
                      <MenuItem
                        disabled={!canClose}
                        title={canClose ? undefined : "Can't close the last open tab"}
                        onClick={() => close(cfg.id)}
                      >
                        Close
                      </MenuItem>
                    </div>
                  </>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={busy}
            title="New config (pick corpus, model & chunk settings)"
            className="cursor-pointer rounded-md px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            +
          </button>

          {closed.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setSavedOpen((o) => !o)}
                disabled={busy}
                title="Reopen a saved config"
                className="cursor-pointer rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
              >
                ⌄ saved ({closed.length})
              </button>
              {savedOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSavedOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                    {closed.map((cfg) => (
                      <button
                        key={cfg.id}
                        type="button"
                        onClick={() => reopen(cfg.id)}
                        className="flex w-full cursor-pointer flex-col items-start px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <span className="truncate font-medium text-zinc-700 dark:text-zinc-300">
                          {cfg.label}
                        </span>
                        <span className="truncate text-xs text-zinc-400">
                          {cfg.baseModel} · {cfg.chunkSize}/{cfg.chunkOverlap} · {cfg.corpusName ?? "no corpus"} ·{" "}
                          {new Date(cfg.createdAt).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right: pinned cross-config Appraise tab */}
        <Link
          href="/appraise"
          className="mb-1 shrink-0 rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        >
          📊 Appraise
        </Link>
      </div>

      {error && <p className="pb-1 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {showCreate && (
        <ConfigCreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            router.refresh();
            gotoConfig(id);
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  title,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="block w-full cursor-pointer px-3 py-1 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}
