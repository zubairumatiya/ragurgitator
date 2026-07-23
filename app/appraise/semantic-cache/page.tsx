// Appraise → Semantic caching. A peer page of the cross-config metrics table
// (see app/appraise/page.tsx), under the shared AppraiseNav. Surfaces Phase 2
// of the semantic cache (docs/semantic-caching-plan.md): the per-space
// thresholds, the eval-bank collision floor, and the shadow-judge calibration.
//
// The page frame is a Server Component; the three panels are self-fetching
// Client Components (they read/write the /api/semantic-cache/* routes and
// refresh each other via a window event), so nothing needs threading through.
import Link from "next/link";

import { AppraiseNav } from "@/app/components/AppraiseNav";
import { CollisionFloorPanel } from "@/app/components/semanticCache/CollisionFloorPanel";
import { ShadowJudgePanel } from "@/app/components/semanticCache/ShadowJudgePanel";
import { ThresholdsPanel } from "@/app/components/semanticCache/ThresholdsPanel";

export const dynamic = "force-dynamic";

export default function SemanticCachePage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-8 py-12">
        <Link
          href="/"
          className="self-start text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to configs
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            📊 Appraise
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Semantic answer cache calibration — the per-space cosine threshold that
            decides when a past answer is served for a new question. Lower it only
            where it&apos;s proven safe: the <em>collision floor</em> from the eval
            bank, or the <em>shadow judge</em> over real would-hit traffic.
          </p>
        </header>

        <AppraiseNav />

        <ThresholdsPanel />
        <CollisionFloorPanel />
        <ShadowJudgePanel />
      </main>
    </div>
  );
}
