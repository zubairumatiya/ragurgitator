// Appraise → Trial times. Wall-clock history for autotune runs (migration 0041),
// so a speed optimization can be read against a measured baseline instead of a
// memory of how long the last run took.
//
// Config-scoped rather than account-wide, unlike Costs: a run's duration is only
// meaningful next to runs over the same corpus and the same below-bar workload,
// so pooling configs here would average unrelated jobs. Scope comes from
// ?configId= via the shared CostsConfigPicker, pointed at this route and with
// its all-configs option turned off (there's no pooled reading to show).
//
// `searchParams` is a Promise in this Next.js version (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md),
// so it must be awaited; force-dynamic already guarantees the DB reads run per
// request.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { CostsConfigPicker } from "@/app/components/CostsConfigPicker";
import TrialsSection from "@/app/components/TrialsSection";
import { listTrialRuns } from "@/lib/rag/autotuneStore";
import { listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

export const dynamic = "force-dynamic";

export default async function AppraiseTrialsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const raw = (await searchParams).configId;
  const requested = Array.isArray(raw) ? raw[0] : raw;

  const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
  const configs = [...open, ...closed];

  // Timings are per-config, so there's no "all configs" reading to fall back to:
  // an unknown or absent id lands on the default config (the earliest), which is
  // the one the harness also targets when run without --config.
  const configId =
    configs.find((c) => c.id === requested)?.id ?? configs[0]?.id ?? "";
  const groups = configId ? await listTrialRuns(configId) : [];

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-4 px-8 py-8">
        <BackToConfigs />

        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
        </h1>

        <AppraiseNav />

        <CostsConfigPicker
          configs={configs}
          value={configId}
          basePath="/appraise/trials"
          allowAll={false}
        />

        <TrialsSection groups={groups} />
      </main>
    </div>
  );
}
