// My cache — a read-only window onto the semantic answer cache (linked from the
// sidebar). Lists every question/answer pair banked across ALL of this user's
// configs, most-served first, so "what has my cache learned, and what is it
// actually saving me" is answerable without a psql prompt.
//
// Standalone (outside /c/[configId]) like Corpora and Appraise: the listing
// spans configs, so a per-config banner/sub-nav would be actively misleading.
// Dynamic — it reads the DB per request.
//
// Read-only on purpose. The cache maintains itself: entries are written by
// semanticCacheStore on a miss and self-pruned when a config's fingerprint
// changes (lib/rag/semanticCache.ts). There is no delete control here because
// there is no state a user can usefully hand-edit — a wrong answer is fixed by
// changing the config or the threshold, both of which invalidate the entry
// anyway. Calibration lives on Appraise → Semantic caching.
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { CacheTable } from "@/app/components/CacheTable";
import { InfoDot } from "@/app/components/InfoDot";
import { withPageUser } from "@/lib/auth/dal";
import { listCacheEntries } from "@/lib/rag/semanticCache";

export const dynamic = "force-dynamic";

const ABOUT =
  "The semantic answer cache: when you ask a question close enough to one " +
  "you've asked before, the stored answer is served and the whole retrieval " +
  "and generation step is skipped.\n\n" +
  "'Served' counts how many times each entry has been reused — every one of " +
  "those is an answer you didn't pay for. Entries are scoped to the config " +
  "that produced them, because the same question has a different answer " +
  "against a different corpus, chunking or model.";

export default async function CachePage() {
  const entries = await withPageUser(() => listCacheEntries());
  const totalServed = entries.reduce((n, e) => n + e.hitCount, 0);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-8 py-12">
        <BackToConfigs />

        <header className="flex flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            My cache
            <InfoDot text={ABOUT} />
          </h1>
          {entries.length > 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {entries.length} cached answer{entries.length === 1 ? "" : "s"} ·{" "}
              {totalServed} served from cache
            </p>
          )}
        </header>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nothing cached yet. Ask a question in a chat — the answer is banked, and
            the next question close enough to it is served from here for free.
          </div>
        ) : (
          <CacheTable entries={entries} />
        )}
      </main>
    </div>
  );
}
