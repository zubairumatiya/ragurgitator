// Appraise → Semantic caching. A peer page of Costs and the cross-config metrics
// table (see app/appraise/configs/page.tsx), under the shared AppraiseNav. Surfaces Phase 2
// of the semantic cache (docs/semantic-caching-plan.md): the eval-bank collision
// floor, the per-space thresholds, and the shadow-judge calibration.
//
// Panel order follows the order you'd actually work in, cheapest evidence first:
//   1. Collision floor — pure arithmetic over the eval bank, no LLM spend, usable
//      the moment a config has labeled questions. Where a threshold starts.
//   2. Thresholds by vector-space — what's live now, plus the apply control on
//      its heading row. The recommendation from (1) lands here; (3) sits below
//      so the box you apply from is between the two panels that feed it.
//   3. Shadow judge — needs real would-hit traffic and costs judge tokens, so
//      it's the refinement you reach for after (1), not the starting point.
//
// The page frame is a Server Component; the panels are self-fetching Client
// Components (they read the /api/semantic-cache/* routes and talk to each other
// over window events — see semanticCache/events.ts: calibration panels
// `emitRecommendation`, the apply panel listens and prefills, and a write
// broadcasts SC_CHANGED so the table and apply panel re-pull). Nothing needs
// threading through, and the wiring is order-independent — recommendations are
// emitted from fetch callbacks, long after every listener has mounted.
// ApplyThresholdPanel is the only one that WRITES a threshold; the rest display
// data and feed it recommendations.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { InfoDot } from "@/app/components/InfoDot";
import { ApplyThresholdPanel } from "@/app/components/semanticCache/ApplyThresholdPanel";
import { CollisionFloorPanel } from "@/app/components/semanticCache/CollisionFloorPanel";
import { ShadowJudgePanel } from "@/app/components/semanticCache/ShadowJudgePanel";
import { ThresholdsPanel } from "@/app/components/semanticCache/ThresholdsPanel";

export const dynamic = "force-dynamic";

const ABOUT =
  "Semantic answer cache calibration — the per-space cosine threshold that " +
  "decides when a past answer is served for a new question.\n\n" +
  "Lower it only where it's proven safe: the collision floor from the eval " +
  "bank, or the shadow judge over real would-hit traffic.";

export default function SemanticCachePage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-4 px-8 py-8">
        <BackToConfigs />

        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
          <InfoDot text={ABOUT} />
        </h1>

        <AppraiseNav />

        <CollisionFloorPanel />

        {/* The apply control rides on the thresholds heading row — the table that
            shows thresholds is where you'd look to change one, and sharing the
            row keeps the page's one write action off its own line. Sitting
            second, it's also within a screen of both panels that recommend
            into it. */}
        <ThresholdsPanel action={<ApplyThresholdPanel />} />

        <ShadowJudgePanel />
      </main>
    </div>
  );
}
