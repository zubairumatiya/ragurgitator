// Instant loading shell shared by every Appraise leaf page, wired up through a
// one-line loading.tsx in each of app/appraise/{costs,semantic-cache,configs}/.
//
// Why it exists: every Appraise page is `force-dynamic`, and per
// node_modules/next/dist/docs/01-app/02-guides/prefetching.md a dynamic route is
// NOT prefetched at all unless it has a loading boundary — the router had
// nothing cached, no shell to stream into, and no fallback to paint. Clicking
// "📊 Appraise" therefore left you sitting on the *previous* page for a full
// server round trip with zero feedback, which reads as "Appraise takes ages to
// load". It's worst right after /eval loads, when the tab is still busy with
// EvalDashboard's payload and the browser is fetching the destination's chunks
// cold.
//
// The boundary lives in the LEAF segments, not in app/appraise/, on purpose: a
// loading.tsx at the section root would also wrap app/appraise/page.tsx, and
// flushing its shell first downgrades that page's redirect() from a real HTTP
// 307 to a client-side bounce (headers are already sent).
//
// The frame is duplicated from the pages rather than hoisted into a layout
// because each page owns its own InfoDot copy; keep the wrapper classes in sync
// with app/appraise/*/page.tsx.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";

export function AppraiseLoading() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-4 px-8 py-8">
        <BackToConfigs />

        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
        </h1>

        {/* Real nav, not a placeholder — usePathname already reports the
            destination during the transition, so the target tab is highlighted
            and the other tabs stay clickable while the page loads. */}
        <AppraiseNav />

        <div className="flex animate-pulse flex-col gap-3" aria-hidden>
          <div className="h-8 w-64 rounded-md bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-48 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-32 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <span className="sr-only" role="status">
          Loading Appraise…
        </span>
      </main>
    </div>
  );
}
