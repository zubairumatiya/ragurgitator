// "← Back to configs" — the escape hatch on the standalone pages (Appraise,
// Corpora), which sit outside /c/[configId] and so have no tab bar of their own.
//
// The naive href was "/", but / redirects to the FIRST OPEN config, so leaving a
// config to check a metric and coming back dumped you on someone else's tab.
// Instead we remember where you were: RememberConfigRoute (rendered by the
// config layout) writes every /c/… pathname to sessionStorage, and the link
// reads it back. sessionStorage — not localStorage — so a second window keeps
// its own idea of "where I was", and a fresh session starts clean.
//
// SSR-safe by construction: sessionStorage is read through useSyncExternalStore,
// whose server snapshot is "/" — the server never touches storage, and the href
// upgrades on hydration. Worst case the user clicks in the ~1 frame before
// hydration and gets the old behaviour.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

const KEY = "rag:lastConfigRoute";

// Mounted by app/c/[configId]/layout.tsx, so it sees every config-scoped page
// (Workbench / Clusters / Evals and their sub-routes). Standalone pages are not
// under that layout, so /appraise* and /corpora* never overwrite the memory —
// the startsWith guard is belt-and-braces for a future re-mount elsewhere.
export function RememberConfigRoute() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname.startsWith("/c/")) return;
    try {
      sessionStorage.setItem(KEY, pathname);
    } catch {
      // Private mode / storage disabled — the link just falls back to "/".
    }
  }, [pathname]);
  return null;
}

// The memory only changes while you're on a /c/… page — i.e. never while this
// link is mounted — so there is nothing to subscribe to.
const subscribe = () => () => {};

// Only trust a config route: anything else (a stale key from an older version,
// hand-edited storage, storage disabled) falls through to the "/" redirect.
// Returning the same string for the same stored value keeps the snapshot stable.
function readRemembered(): string {
  try {
    const remembered = sessionStorage.getItem(KEY);
    return remembered?.startsWith("/c/") ? remembered : "/";
  } catch {
    return "/";
  }
}

const serverHref = () => "/";

export function BackToConfigs() {
  const href = useSyncExternalStore(subscribe, readRemembered, serverHref);

  return (
    <Link
      href={href}
      className="self-start text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
    >
      ← Back to configs
    </Link>
  );
}
