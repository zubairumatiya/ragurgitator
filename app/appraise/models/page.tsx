// Appraise → Models (docs/appraise-model-comparison-plan.md). Two questions the
// app couldn't answer before: what does each embedding model cost per token, and
// how has each one performed here.
//
// Embedding models only. The Anthropic answer/judge models are priced in
// pricing.ts as well, but nothing measures their quality — they'd be a table of
// prices with every metric dashed, which belongs on Costs, not here.
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
import { listModelRateCard, meteredEmbedTokens } from "@/lib/rag/modelAppraisal";
import { availableProviders } from "@/lib/rag/providerAvailability";
import { listReplays } from "@/lib/rag/replayStore";

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
  const [rateCard, replays, comparisons, embedTokens] = await withPageUser(async () =>
    Promise.all([
      availableProviders().then(listModelRateCard),
      listReplays(),
      listConfigComparisons(),
      meteredEmbedTokens(),
    ]),
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
        <ModelReplayTable reports={replays} comparisons={comparisons} />
      </main>
    </div>
  );
}
