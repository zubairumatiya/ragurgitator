// UI: the persistent demo banner (Client Component), rendered by the root layout
// so it frames every page a guest can reach.
//
// Self-fetching for the same reason the Sidebar is: the root layout must not
// read the DB, since it also wraps build-time statics like the 404 page. It asks
// /api/auth/me, which answers with the guest flag and the expiry, and renders
// NOTHING for a real account — no request cost beyond the one the sidebar was
// already making, and no markup for the people it isn't about.
//
// THREE THINGS, because they are the three questions a visitor has: what is
// this, what won't work, and how long have I got. The countdown is the one worth
// the extra code — a workspace that will vanish should say so continuously
// rather than surprising someone mid-experiment.
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/http/client";

type Me = { guest?: { isGuest: boolean; expiresAt: string | null } };

// "1h 47m", "12m", "any moment now". Deliberately coarse: a demo does not need
// a ticking second hand, and a minute-granularity label re-renders once a
// minute instead of sixty times.
function remaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "any moment now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function DemoBanner() {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [isGuest, setIsGuest] = useState(false);
  // Re-render the countdown on a timer. The state is a tick counter rather than
  // the formatted string so the format lives in one place.
  const [, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      // A 401 here is the ordinary case on /login, not an error worth surfacing:
      // the banner simply has nobody to be about.
      const res = await apiFetch("/api/auth/me").catch(() => null);
      if (!live || !res?.ok) return;
      const body = (await res.json().catch(() => null)) as Me | null;
      if (!live || !body?.guest?.isGuest) return;
      setIsGuest(true);
      setExpiresAt(body.guest.expiresAt);
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!isGuest) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span className="font-medium">Demo workspace</span>
      <span className="opacity-80">
        Everything here is a private copy. Anything that spends money — uploads,
        re-chunking, autotune, generating questions — is switched off.
      </span>
      {expiresAt ? <span className="opacity-80">Expires in {remaining(expiresAt)}.</span> : null}
      <Link href="/signup" className="font-medium underline underline-offset-2">
        Sign up to keep this
      </Link>
    </div>
  );
}
