// Appraise → Models. Two questions the app couldn't answer before: what does each
// embedding model cost per token, and how has each one performed here.
//
// Both model kinds are priced here now. The original note said LLMs didn't belong —
// "a table of prices with every metric dashed" — and that was right while nothing
// could CHOOSE one. The config LLM picker changed the premise: a config's answer
// model is now a setting with eleven options across two providers, so "what will
// this cost me" has a decision behind it. The quality half is still
// embeddings-only — the replay ranks the corpus, which is not something an answer
// model does — so the LLM section is a rate card and nothing more.
//
// Standalone (outside /c/[configId]) like its sibling Appraise tabs, so no
// per-config banner. Dynamic — it reads the DB per request.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { InfoDot } from "@/app/components/InfoDot";
import { ModelRateCard } from "@/app/components/ModelRateCard";
import { ModelReplayTable } from "@/app/components/ModelReplayTable";
import { withPageUser } from "@/lib/auth/dal";
import { listConfigComparisons } from "@/lib/rag/appraiseStore";
import { LlmRateCard } from "@/app/components/LlmRateCard";
import {
  listLlmRateCard,
  listModelRateCard,
  meteredEmbedTokens,
} from "@/lib/rag/modelAppraisal";
import { availableProviders } from "@/lib/rag/providerAvailability";
import { listPublishedReplays, listReplays } from "@/lib/rag/replayStore";
import { DEMO_ACTIONS, PUBLISHED_REPLAY_NOTE } from "@/lib/demo/policy";
import { isGuest } from "@/lib/demo/guest";

export const dynamic = "force-dynamic";

const ABOUT =
  "Per-token prices for every embedding model, and how each ranks the corpus.\n\n" +
  "The rate card is always complete. The replay scores every model with cached " +
  "vectors against the same questions — it costs nothing to run, because the " +
  "vectors were already paid for.";

export default async function AppraiseModelsPage() {
  // The rate card's "available?" column is now per-user (strict BYOK), so it
  // needs the availability lookup and therefore a user scope — it moved inside
  // withPageUser with the rest. It is still the cheap one: a single indexed read
  // of user_provider_keys, no vault call.
  //
  // listReplays is the slow one on a cold fingerprint (~8s, dominated by pulling
  // vectors out of embedding_cache) and ~0.4s once cached in replay_metrics.
  // loading.tsx covers the cold case — see AppraiseLoading.
  const [guest, rateCard, llmRateCard, replays, comparisons, embedTokens] = await withPageUser(
    async () => {
      // Both cards' "available?" columns come from the SAME availability lookup —
      // one query answers for embedding and LLM providers alike (see the
      // structural ProviderAvailability type), so adding the second card cost no
      // extra round trip.
      const availability = await availableProviders();
      // THE REPLAY IS THE THIRD VECTOR-SHIPPING SITE (docs/guest-demo-plan.md),
      // and the only one that is a PAGE RENDER rather than an action — a guest
      // reaching this tab would pull the whole corpus's cached vectors back out
      // of the database just by clicking a link (92 MB, measured on the master
      // 2026-08-25). So it is never RUN for a guest; it is not gated either,
      // because assertDemoAllows() throws and an error page is a worse answer
      // than a table saying what it is showing.
      //
      // Phase 6.3: a guest instead reads the rows the publish carried in
      // (lib/demo/clone step 5c) under the sentinel fingerprint. Same corpus,
      // same questions, same models — computed once on the master rather than
      // once per visitor. listPublishedReplays touches no vector column at all,
      // which is what keeps that promise structural rather than conditional.
      const guest = await isGuest();
      return Promise.all([
        guest,
        listModelRateCard(availability),
        listLlmRateCard(availability),
        guest ? listPublishedReplays() : listReplays(),
        listConfigComparisons(),
        meteredEmbedTokens(),
      ]);
    },
  );

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-8 py-8">
        <BackToConfigs />

        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
          <InfoDot text={ABOUT} />
        </h1>

        <AppraiseNav />

        <ModelRateCard rows={rateCard} meteredEmbedTokens={embedTokens} />
        {/* The LLM card sits between the embedding rate card and the replay
            table on purpose: the two price tables read as a pair, and the replay
            (which measures embedding quality only) stays adjacent to the card it
            actually corresponds to. */}
        <LlmRateCard rows={llmRateCard} />
        <ModelReplayTable
          reports={replays}
          comparisons={comparisons}
          emptyNote={guest ? DEMO_ACTIONS.appraise : undefined}
          publishedNote={guest ? PUBLISHED_REPLAY_NOTE : undefined}
        />
      </main>
    </div>
  );
}
