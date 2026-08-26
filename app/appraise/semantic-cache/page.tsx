// Appraise → Semantic caching. A peer page of Costs and the cross-config metrics
// table, under the shared AppraiseNav. Surfaces Phase 2 of the semantic cache: the
// eval-bank collision floor, the per-space thresholds, and the shadow-judge
// calibration.
//
// Panel order follows the order you'd actually work in, cheapest evidence first,
// and each panel is NUMBERED with its place in it:
//   1. Collision floor — pure arithmetic over the eval bank, no LLM spend, usable
//      the moment a config has labeled questions. The apply control sits in its
//      footer so the recommendation and the box that makes it live are one reading
//      order apart.
//   2. Thresholds by vector-space — what's live now, read-only.
//   3. Shadow judge — needs real would-hit traffic and costs judge tokens, so it's
//      the refinement you reach for after (1).
//   4. Cache key model — the only panel that isn't about a threshold's VALUE: it
//      changes WHICH SPACE a config reads its threshold from.
//
// All four wear the same card, so they read as four steps of one workflow.
//
// The page frame is a Server Component. It reads the config list and the first
// config's SAVED collision floor here, on the server, and hands them to
// CollisionFloorPanel as props: that panel used to fetch the list and then — a
// second round trip deep — the floor, so opening this tab painted an empty panel
// and popped the numbers in a moment later.
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
import {
  CollisionFloorPanel,
  type CollisionFloorPreload,
} from "@/app/components/semanticCache/CollisionFloorPanel";
import { KeyModelPanel } from "@/app/components/semanticCache/KeyModelPanel";
import { ShadowJudgePanel } from "@/app/components/semanticCache/ShadowJudgePanel";
import { ThresholdsPanel } from "@/app/components/semanticCache/ThresholdsPanel";
import { withPageUser } from "@/lib/auth/dal";
import { isGuest } from "@/lib/demo/guest";
// THE DEMO COPY CROSSES HERE, and it has to: lib/demo/policy is `import
// "server-only"`, and KeyModelPanel is a Client Component. Same boundary
// app/appraise/models/page.tsx:29 uses for the replay's two sentences — the
// sentences are read on the server and handed down as props, so the panel never
// imports the policy table it is quoting.
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
  "bank, or the shadow judge over real would-hit traffic.";

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

        {/* gap-3 between cards, against the page's gap-4 above: the cards have
            their own borders and padding, so they need less air between them
            than the unboxed header block does. */}
        <div className="flex flex-col gap-3">
          {/* The apply control goes in the collision-floor panel's FOOTER: the
              floor is where a threshold starts, so the number and the control
              that puts it live are one card apart rather than one page apart.
              Both panels that recommend into it (collision floor here, shadow
              judge below) stay within a screen. */}
          <CollisionFloorPanel
            configs={configs}
            preload={preload}
            action={<ApplyThresholdPanel />}
          />

          <ThresholdsPanel />

          <ShadowJudgePanel />

          {/* Same list, same order, as the collision floor above: its pair GAP is
              config-scoped, and this page carries no configId of its own, so
              without a picker the gap silently described the Default config. */}
          {/* The demo copy travels as ONE prop rather than six, so the panel
              cannot render the published-sweep note while missing the one that
              says the leaderboard is frozen — the two only make sense together
              (phase 5 of docs/demo-cache-lab-plan.md). Undefined for a real
              account, which is what every `notes &&` in the panel tests. */}
          <KeyModelPanel
            configs={configs}
            notes={
              guest
                ? {
                    sweep: PUBLISHED_SWEEP_NOTE,
                    pairs: PUBLISHED_PAIRS_NOTE,
                    revealed: REVEALED_PAIRS_NOTE,
                    screen: PUBLISHED_SCREEN_NOTE,
                    probe: GUEST_PROBE_NOTE,
                    live: LIVE_HALF_NOTE,
                  }
                : undefined
            }
          />
        </div>
      </main>
    </div>
  );
}
