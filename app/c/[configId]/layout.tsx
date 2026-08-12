// Layout for every config-scoped page (/c/[configId]/…). Renders the shell:
//   1. ConfigTabs    — the cross-config tab bar (open tabs + new + Appraise).
//   2. active banner — "<name> · <model> · <size>/<overlap> · corpus: <name>".
//   3. Nav           — the nested Workbench / Eval / Clusters sub-nav.
//   4. {children}    — the page, scoped to this config.
//
// A Server Component so it can read the tab lists + active config straight from
// configStore. It re-renders when the [configId] segment changes so the banner stays
// in sync. `params` is a Promise in this Next.js version — await it.
//
// notFound() is used for an unknown configId so a stale/bad tab URL 404s rather than
// rendering a bannerless shell.
import Link from "next/link";
import { notFound } from "next/navigation";
import { RememberConfigRoute } from "@/app/components/BackToConfigs";
import { ConfigTabs } from "@/app/components/ConfigTabs";
import { Nav } from "@/app/components/Nav";
import { withPageUser } from "@/lib/auth/dal";
import { getConfig, listClosedConfigs, listConfigs } from "@/lib/rag/configStore";

export default async function ConfigLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ configId: string }>;
}) {
  const { configId } = await params;
  // All three reads are owner-scoped, so a config id belonging to another
  // account 404s exactly like a deleted one — no shell, no tab bar, no leak of
  // the config's name through the banner.
  const { active, open, closed } = await withPageUser(async () => {
    const [active, open, closed] = await Promise.all([
      getConfig(configId),
      listConfigs(),
      listClosedConfigs(),
    ]);
    return { active, open, closed };
  });
  if (!active) notFound();

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      {/* Renders nothing — records this route so Appraise/Corpora's
          "← Back to configs" can return you to the view you left. */}
      <RememberConfigRoute />

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
