// Appraise → Semantic caching. A peer page of Costs and the cross-config metrics
// table, under the shared AppraiseNav. Surfaces Phase 2 of the semantic cache: the
// eval-bank collision floor, the per-space thresholds, and the would-hit queue.
//
// FOUR SECTIONS, EACH OWNING EXACTLY ONE OUTPUT. They were five panels numbered
// 1–4 as steps of one workflow, which they never were: two stand alone, and the
// numbering implied an order nobody works in.
//   • Pair bank      — the labeled pair set. Extracted from the leaderboard, which
//     was only one of its two consumers; the probe is the other.
//   • Would-hit queue — judged verdicts on real traffic.
//   • Threshold      — the live τ. "Thresholds by vector-space" and "Collision
//     floor" merged: the floor is a CONSTRAINT on the live value, not a peer
//     recommendation beside it, and the apply box — the page's only threshold
//     write — moved into its footer from the floor's. The floor runs over three
//     populations (eval bank / pair bank / real traffic), of which only the eval
//     bank's may be applied.
//   • Cache key model — which vector-space a config reads its threshold FROM.
//
// Evidence first, then the number it justifies, then the space that number is read
// in. Nothing enforces this order; it is the order the outputs depend on.
//
// The page frame is a Server Component. It reads the config list and the first
// config's SAVED collision floor here, on the server, and hands them to
// ThresholdPanel as props: it used to fetch the list and then — a second round
// trip deep — the floor, so opening this tab painted an empty panel and popped the
// numbers in a moment later.
//
// Everything else is still self-fetching Client Components, talking to each other
// over window events (see semanticCache/events.ts): calibration panels
// `emitRecommendation`, the apply panel listens and prefills, and a write broadcasts
// SC_CHANGED so the table and apply panel re-pull. The wiring is order-independent
// — recommendations are emitted from fetch callbacks, long after every listener has
// mounted. ApplyThresholdPanel is the only one that WRITES a threshold.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { InfoDot } from "@/app/components/InfoDot";
import { ApplyThresholdPanel } from "@/app/components/semanticCache/ApplyThresholdPanel";
import { KeyModelPanel } from "@/app/components/semanticCache/KeyModelPanel";
import { PairBankPanel } from "@/app/components/semanticCache/PairBankPanel";
import { ShadowJudgePanel } from "@/app/components/semanticCache/ShadowJudgePanel";
import {
  ThresholdPanel,
  type CollisionFloorPreload,
} from "@/app/components/semanticCache/ThresholdPanel";
import { withPageUser } from "@/lib/auth/dal";
// NO DEMO COPY CROSSES HERE ANY MORE — phase 5 of docs/demo-cache-replay-plan.md.
// Six sentences used to be read on the server and handed down as `notes` props,
// because lib/demo/policy is `import "server-only"` and every panel below is a
// Client Component. They explained a page that behaved differently for a guest:
// a frozen leaderboard, a "Generate" that revealed, a screen that resolved. Every
// one of those now does the same arithmetic a real account's does, over a banked
// similarity matrix instead of a paid embedding run, so THIS PAGE RENDERS
// IDENTICALLY FOR A GUEST AND FOR AN ACCOUNT. With nothing behaving differently
// there is nothing to explain, and the global DemoBanner already states what a
// demo is. The one thing a guest does not see is the probe, and PairBankPanel
// hides it off the banked matrix rather than off a flag from here.
import { resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { readCollisionFloorState } from "@/lib/rag/collisionFloorStore";
import { listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

export const dynamic = "force-dynamic";

const ABOUT =
  "Semantic answer cache calibration — the per-space cosine threshold that " +
  "decides when a past answer is served for a new question.\n\n" +
  "Lower it only where it's proven safe: the collision floor from the eval " +
  "bank, or judged verdicts over the would-hit queue.";

// The saved floor for the config the panel opens on — the FIRST in the picker's
// order, which is what the panel selects by default. Best-effort, matching
// collisionFloorStore's contract: if this read fails (or there are no configs
// yet) the panel gets no preload and falls back to fetching on mount, exactly as
// it did before. A display cache must never take the page down with it.
async function preloadFirstFloor(
  configId: string | undefined,
): Promise<CollisionFloorPreload | null> {
  if (!configId) return null;
  try {
    const cfg = await resolveConfig(configId);
    if (!cfg) return null;
    return { configId, ...(await withConfig(cfg, readCollisionFloorState)) };
  } catch (err) {
    console.warn(`[rag:collision-floor] preload failed: ${(err as Error).message}`);
    return null;
  }
}

export default async function SemanticCachePage() {
  const { configs, preload } = await withPageUser(async () => {
    // Same list, in the same order, the panel's picker used to fetch for itself:
    // open tabs then closed ones.
    const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
    const configs = [...open, ...closed];
    return {
      configs,
      preload: await preloadFirstFloor(configs[0]?.id),
    };
  });

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-4 px-8 py-8">
        <BackToConfigs />

        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
          <InfoDot text={ABOUT} />
        </h1>

        <AppraiseNav />

        {/* gap-3 between cards, against the page's gap-4 above: the cards have
            their own borders and padding, so they need less air between them
            than the unboxed header block does. */}
        <div className="flex flex-col gap-3">
          {/* The bank's GAP is config-scoped and this page carries no configId of
              its own, so without the list it would silently describe the Default
              config. */}
          <PairBankPanel configs={configs} />

          <ShadowJudgePanel />

          {/* The apply control goes in the Threshold section's FOOTER — the one
              place on the page a threshold is written, directly under the live
              table it changes and the floor that constrains it. Both panels that
              recommend into it (the would-hit queue above, the floor here) send a
              number; nothing is live until it is applied here. */}
          <ThresholdPanel
            configs={configs}
            preload={preload}
            action={<ApplyThresholdPanel />}
          />

          <KeyModelPanel />
        </div>
      </main>
    </div>
  );
}
