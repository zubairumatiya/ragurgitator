// ---------------------------------------------------------------------------
// Layout for every config-scoped page (/c/[configId]/…). Renders the §6 shell:
//   1. ConfigTabs    — the cross-config tab bar (open tabs + new + Appraise).
//   2. active banner — "<name> · <model> · <size>/<overlap> · corpus: <name>".
//   3. Nav           — the nested Playground / Eval / Clusters sub-nav.
//   4. {children}    — the page, scoped to this config.
//
// This is a Server Component so it can read the tab lists + active config straight
// from configStore. It re-renders when the [configId] segment changes (switching
// tabs) so the banner stays in sync; ConfigTabs router.refresh()es it after
// mutations. `params` is a Promise in this Next.js version — await it.
//
// notFound() is used for an unknown configId so a stale/bad tab URL 404s rather
// than rendering a bannerless shell. See node_modules/next/dist/docs for the
// file-convention details.
// ---------------------------------------------------------------------------
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfigTabs } from "@/app/components/ConfigTabs";
import { Nav } from "@/app/components/Nav";
import { getConfig, listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

export default async function ConfigLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ configId: string }>;
}) {
  const { configId } = await params;
  const [active, open, closed] = await Promise.all([
    getConfig(configId),
    listConfigs(),
    listClosedConfigs(),
  ]);
  if (!active) notFound();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      <ConfigTabs open={open} closed={closed} activeId={active.id} />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-10">
        {/* Active-config banner — which experiment everything below is scoped to. */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="text-zinc-500">active:</span>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{active.label}</span>
          {/* Auto-sync itself is toggled from the Nav's Settings dropdown. */}
          <span className="font-mono text-xs text-zinc-500">
            ({active.baseModel} · {active.chunkSize}/{active.chunkOverlap} · corpus:{" "}
            {active.corpusId ? (
              <Link href={`/corpora/${active.corpusId}`} className="hover:underline">
                {active.corpusName}
                {active.corpusSync && " ⟳"}
              </Link>
            ) : (
              "none"
            )}
            )
          </span>
        </div>

        <Nav />

        {children}
      </main>
    </div>
  );
}
