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
import { ModelComparisonTable } from "@/app/components/ModelComparisonTable";
import { ModelRateCard } from "@/app/components/ModelRateCard";
import {
  listModelPerformance,
  listModelRateCard,
  meteredEmbedTokens,
} from "@/lib/rag/modelAppraisal";

export const dynamic = "force-dynamic";

const ABOUT =
  "Per-token prices for every embedding model, and how each has scored on this " +
  "corpus.\n\n" +
  "The rate card is always complete. The performance table only fills in as you " +
  "run evals and per-chunk model trials — and the badge tells you how much each " +
  "row's number is worth.";

export default async function AppraiseModelsPage() {
  // listModelRateCard is sync (registry + env, no IO); only the two DB reads
  // need awaiting, and they're independent.
  const rateCard = listModelRateCard();
  const [performance, embedTokens] = await Promise.all([
    listModelPerformance(),
    meteredEmbedTokens(),
  ]);

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
        <ModelComparisonTable rows={performance} />
      </main>
    </div>
  );
}
