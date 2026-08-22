// The demo's front door. Public — proxy.ts lets /demo through unauthenticated.
//
// It exists because the portfolio's whole problem was that an employer following
// a link hit a login wall asking them for a Voyage key. This page is the one
// click between that link and a working workspace, so it says what they are
// about to get, what it costs them (nothing), and what it won't do — and then
// gets out of the way.
//
// DB-FREE by construction: it reads config flags and renders. Nothing here needs
// a session, and a page on the unauthenticated path that touched the store would
// be a scope violation waiting to happen.
import Link from "next/link";
import { notFound } from "next/navigation";

import { Wordmark } from "@/app/components/Logo";
import { StartDemo } from "@/app/components/StartDemo";
import { demo, demoEnabled } from "@/lib/demo/config";

export const metadata = { title: "Try the demo" };

// The flags are env-driven, so this must not be frozen at build time.
export const dynamic = "force-dynamic";

export default async function DemoPage() {
  // A deployment without the demo configured has no demo. Same answer the API
  // gives, for the same reason: there is nothing here to come back for.
  if (!demoEnabled()) notFound();

  const hours = Math.round(demo.ttlMinutes / 60);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <Wordmark size={46} textClassName="text-xl" />

      <div className="flex flex-col gap-3">
        <h1 className="text-sm font-medium">A RAG workbench you can actually run</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No account, no API keys. You get your own private copy of a real corpus —
          documents, ingested chunks, tuned configs, a labelled question bank and a
          bank of pre-computed answers — and everything on top of it is live.
        </p>
      </div>

      <StartDemo />

      <div className="flex flex-col gap-2 text-xs text-zinc-500">
        <p>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">What works:</span>{" "}
          asking questions and watching the semantic cache answer them, browsing
          retrieval and its scores, the eval bank and its metrics, cost and savings
          accounting, and the config tabs.
        </p>
        <p>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">What doesn&apos;t:</span>{" "}
          anything that spends money on someone else&apos;s behalf — uploading documents,
          re-chunking, autotune, generating new questions. Those need your own keys.
        </p>
        <p>
          The workspace is deleted after {hours} {hours === 1 ? "hour" : "hours"}. Nothing
          you do in it touches anyone else&apos;s.
        </p>
      </div>

      <p className="text-xs text-zinc-500">
        Want to keep what you build?{" "}
        <Link href="/signup" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
          Create a free account
        </Link>{" "}
        and bring your own keys.
      </p>
    </div>
  );
}
