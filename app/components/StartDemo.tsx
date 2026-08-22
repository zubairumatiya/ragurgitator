// UI: the "Try the demo" button (Client Component).
//
// A fetch rather than a form action, for one reason: provisioning takes a few
// seconds — a Voyage verify, a Key Vault wrap, then the clone — and a button
// that says nothing for that long reads as broken. The pending copy is the
// feature here, not the POST.
//
// The redirect target comes from the server (the guest's leftmost tab) rather
// than being guessed here, so the page nobody has seen yet is chosen by the code
// that just created it.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BUTTON } from "@/app/components/formStyles";

export function StartDemo({ label = "Try the demo" }: { label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/start", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { redirect?: string; error?: string }
        | null;

      if (!res.ok || !body?.redirect) {
        setError(body?.error ?? "The demo is unavailable right now.");
        setPending(false);
        return;
      }
      // Deliberately NOT resetting `pending`: the navigation is the end of this
      // component's life, and flipping the button back to its idle label for the
      // moment before the route changes just looks like the click was lost.
      router.replace(body.redirect);
      // The session cookie was set by the POST, so every Server Component on the
      // way in has to be re-fetched rather than served from the router cache.
      router.refresh();
    } catch {
      setError("Couldn't reach the demo. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={start} disabled={pending} className={BUTTON}>
        {pending ? "Setting up your workspace…" : label}
      </button>
      {pending ? (
        <p className="text-xs text-zinc-500">
          Copying a corpus, its configs and its question bank into a workspace of your
          own. Takes a few seconds.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
