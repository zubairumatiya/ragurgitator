// Appraise → Costs. The savings "spreadsheet" (docs/savings-accounting-plan.md),
// promoted out of the metrics page into its own tab so the money view isn't a
// footer under a table of nDCGs.
//
// Scope comes from ?configId= — a Server Component render either way: the picker
// is a tiny Client Component that rewrites the URL, and getCostsReport does the
// filtering in SQL. `searchParams` is a Promise in this Next.js version (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md),
// so it must be awaited; reading it also forces dynamic rendering, which
// force-dynamic already guarantees for the DB reads.
import { AppraiseNav } from "@/app/components/AppraiseNav";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import CostsSection from "@/app/components/CostsSection";
import { CostsConfigPicker } from "@/app/components/CostsConfigPicker";
import { withPageUser } from "@/lib/auth/dal";
import { listClosedConfigs, listConfigs } from "@/lib/rag/configStore";
import { getCostsReport } from "@/lib/rag/savingsStore";

export const dynamic = "force-dynamic";

export default async function AppraiseCostsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const raw = (await searchParams).configId;
  const requested = Array.isArray(raw) ? raw[0] : raw;

  const { configs, configId, report } = await withPageUser(async () => {
    const [open, closed] = await Promise.all([listConfigs(), listClosedConfigs()]);
    const configs = [...open, ...closed];

    // An unknown id (deleted config, hand-typed URL) falls back to the
    // account-wide view instead of rendering a confusingly empty report. Since
    // both lists are owner-scoped, this membership test doubles as the
    // authorization check — another user's configId is simply "unknown" here.
    const configId = configs.some((c) => c.id === requested) ? requested! : "";
    return { configs, configId, report: await getCostsReport(configId || null) };
  });

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-4 px-8 py-8">
        <BackToConfigs />

        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          📊 Appraise
        </h1>

        <AppraiseNav />

        <CostsConfigPicker configs={configs} value={configId} />

        <CostsSection report={report} />
      </main>
    </div>
  );
}
