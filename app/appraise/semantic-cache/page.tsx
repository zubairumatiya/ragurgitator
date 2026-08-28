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
import { isGuest } from "@/lib/demo/guest";
// THE DEMO COPY CROSSES HERE, and it has to: lib/demo/policy is `import
// "server-only"`, and every panel below is a Client Component. Same boundary
// app/appraise/models/page.tsx:29 uses for the replay's two sentences — the
// sentences are read on the server and handed down as props, so no panel imports
// the policy table it is quoting.
import {
  GUEST_PROBE_NOTE,
  LIVE_HALF_NOTE,
  PUBLISHED_PAIRS_NOTE,
  PUBLISHED_SCREEN_NOTE,
  PUBLISHED_SWEEP_NOTE,
  REVEALED_PAIRS_NOTE,
} from "@/lib/demo/policy";
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
  const { configs, preload, guest } = await withPageUser(async () => {
    // Same list, in the same order, the panel's picker used to fetch for itself:
    // open tabs then closed ones.
    const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
    const configs = [...open, ...closed];
    return {
      configs,
      preload: await preloadFirstFloor(configs[0]?.id),
      // Read once here rather than per-note: every sentence below is either all
      // present or all absent, and a page that resolved them independently could
      // render half a story.
      guest: await isGuest(),
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

        {/* WHICH HALF OF THIS PAGE IS LIVE, rendered by the page because that is
            whose statement it is: it spans four sections, and it used to sit at
            the top of the leaderboard — the one section it says is frozen. */}
        {guest && (
          <p className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {LIVE_HALF_NOTE}
          </p>
        )}

        {/* gap-3 between cards, against the page's gap-4 above: the cards have
            their own borders and padding, so they need less air between them
            than the unboxed header block does. */}
        <div className="flex flex-col gap-3">
          {/* The bank's GAP is config-scoped and this page carries no configId of
              its own, so without the list it would silently describe the Default
              config. The demo copy travels as ONE prop rather than four, so the
              panel cannot render the reveal note while missing the one that says
              the leaderboard it feeds is frozen — they only make sense together
              (phase 5 of docs/demo-cache-lab-plan.md). Undefined for a real
              account, which is what every `notes &&` in the panel tests. */}
          <PairBankPanel
            configs={configs}
            notes={
              guest
                ? {
                    pairs: PUBLISHED_PAIRS_NOTE,
                    revealed: REVEALED_PAIRS_NOTE,
                    screen: PUBLISHED_SCREEN_NOTE,
                    probe: GUEST_PROBE_NOTE,
                  }
                : undefined
            }
          />

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

          <KeyModelPanel notes={guest ? { sweep: PUBLISHED_SWEEP_NOTE } : undefined} />
        </div>
      </main>
    </div>
  );
}
