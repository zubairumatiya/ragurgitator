// ---------------------------------------------------------------------------
// UI: the left-hand, togglable sidebar (Client Component), rendered by the root
// layout so it frames every page (config tabs, Appraise, the corpora page). It
// holds collapsible sections — "My corpora" (saved document sets) and "My
// configs" (experiments/tabs) — ahead of user accounts, when this becomes the
// account's home.
//
// Self-fetching (GET /api/corpora?includeEmpty=1, GET /api/configs) rather than
// server-fed: the root layout must not read the DB (it also renders build-time
// statics like the 404 page). Lists refresh on route change and on the
// CORPORA_CHANGED window event, which mutating components fire. The sidebar's
// open/closed state and each section's collapse state persist in localStorage,
// exposed to React via useSyncExternalStore (SSR snapshot = open; localStorage
// isn't readable during SSR, and this avoids a setState-in-effect restore).
// Styling mirrors ConfigTabs/Nav (zinc palette).
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/http/client";
import type { ConfigSummary } from "@/lib/rag/configStore";
import type { CorpusSummary } from "@/lib/rag/corpusStore";

// Fired (on window) by anything that creates/changes corpora so the sidebar
// re-pulls its lists without a full navigation.
export const CORPORA_CHANGED = "corpora:changed";

// One localStorage-backed boolean (default true), shared across the sidebar's
// collapse toggles. A single TOGGLED event wakes every subscriber; each reads
// its own key.
const TOGGLED = "sidebar:toggled";
const subscribeToggles = (cb: () => void) => {
  window.addEventListener(TOGGLED, cb);
  return () => window.removeEventListener(TOGGLED, cb);
};
function useStoredOpen(key: string): [boolean, () => void] {
  const open = useSyncExternalStore(
    subscribeToggles,
    () => localStorage.getItem(key) !== "0",
    () => true,
  );
  const toggle = () => {
    localStorage.setItem(key, open ? "0" : "1");
    window.dispatchEvent(new Event(TOGGLED));
  };
  return [open, toggle];
}

// A collapsible sidebar section: chevron + uppercase title (+ optional header
// extra, e.g. the corpora "Manage" link), persisting its collapse per `id`.
function Section({
  id,
  title,
  extra,
  children,
}: {
  id: string;
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, toggle] = useStoredOpen(`sidebar-section-${id}`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 px-1">
        <button
          type="button"
          onClick={toggle}
          title={open ? `Collapse ${title}` : `Expand ${title}`}
          className="flex cursor-pointer items-baseline gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <span className="inline-block w-2 text-[10px]">{open ? "▾" : "▸"}</span>
          {title}
        </button>
        {extra}
      </div>
      {open && <nav className="flex flex-col gap-0.5">{children}</nav>}
    </div>
  );
}

const rowClass = (active: boolean) =>
  active
    ? "flex items-baseline justify-between gap-2 rounded-md bg-white px-2 py-1 text-sm font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
    : "flex items-baseline justify-between gap-2 rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100";

export function Sidebar() {
  const pathname = usePathname();
  const [open, toggle] = useStoredOpen("sidebar-open");
  const [corpora, setCorpora] = useState<CorpusSummary[] | null>(null);
  const [configs, setConfigs] = useState<{
    open: ConfigSummary[];
    closed: ConfigSummary[];
  } | null>(null);

  // Load both lists on mount / navigation, and when a mutation announces
  // itself via CORPORA_CHANGED.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiFetch("/api/corpora?includeEmpty=1")
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setCorpora(d.corpora ?? []);
        })
        .catch(() => {
          if (!cancelled) setCorpora([]);
        });
      apiFetch("/api/configs")
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setConfigs({ open: d.open ?? [], closed: d.closed ?? [] });
        })
        .catch(() => {
          if (!cancelled) setConfigs({ open: [], closed: [] });
        });
    };
    load();
    window.addEventListener(CORPORA_CHANGED, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CORPORA_CHANGED, load);
    };
  }, [pathname]);

  if (!open) {
    return (
      <aside className="sticky top-0 flex h-screen w-11 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={toggle}
          title="Open sidebar"
          className="cursor-pointer rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        >
          ☰
        </button>
      </aside>
    );
  }

  const onCorporaPage = pathname === "/corpora";
  const allConfigs = configs ? [...configs.open, ...configs.closed] : null;

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-zinc-200 bg-zinc-50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={toggle}
          title="Collapse sidebar"
          className="cursor-pointer rounded-md px-2 py-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
        >
          «
        </button>
      </div>

      <Section
        id="corpora"
        title="My corpora"
        extra={
          <Link
            href="/corpora"
            aria-current={onCorporaPage ? "page" : undefined}
            className={
              onCorporaPage
                ? "rounded px-1 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-900"
                : "rounded px-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            }
          >
            Manage
          </Link>
        }
      >
        {corpora === null && (
          <span className="px-2 py-1 text-xs text-zinc-400">Loading…</span>
        )}
        {corpora?.length === 0 && (
          <span className="px-2 py-1 text-xs text-zinc-400">No corpora yet.</span>
        )}
        {corpora?.map((c) => {
          const href = `/corpora/${c.id}`;
          return (
            <Link
              key={c.id}
              href={href}
              title={`${c.name} · ${c.docCount} doc${c.docCount === 1 ? "" : "s"}`}
              aria-current={pathname === href ? "page" : undefined}
              className={rowClass(pathname === href)}
            >
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-xs text-zinc-400">
                {c.docCount === 0 ? "empty" : c.docCount}
              </span>
            </Link>
          );
        })}
      </Section>

      <Section id="configs" title="My configs">
        {allConfigs === null && (
          <span className="px-2 py-1 text-xs text-zinc-400">Loading…</span>
        )}
        {allConfigs?.length === 0 && (
          <span className="px-2 py-1 text-xs text-zinc-400">No configs yet.</span>
        )}
        {allConfigs?.map((c) => {
          const href = `/c/${c.id}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={c.id}
              href={href}
              title={`${c.label} · ${c.baseModel} · ${c.chunkSize}/${c.chunkOverlap} · corpus: ${c.corpusName ?? "none"}`}
              aria-current={active ? "page" : undefined}
              className={rowClass(active)}
            >
              <span className="truncate">{c.label}</span>
              {!c.isOpen && (
                <span className="shrink-0 text-xs text-zinc-400">closed</span>
              )}
            </Link>
          );
        })}
      </Section>
    </aside>
  );
}
