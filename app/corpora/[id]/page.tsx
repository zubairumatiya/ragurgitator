// Corpus detail — one corpus's page (sidebar rows link here): its documents
// (add existing / upload / remove) and, at the top, the configs attached to it,
// marking which are auto-synced. Standalone like the corpora list. `params` is
// a Promise in this Next.js version. Dynamic — it reads the DB per request.
import Link from "next/link";
import { notFound } from "next/navigation";
import { CorpusDeleteButton } from "@/app/components/CorpusDeleteButton";
import { CorpusDocsPanel } from "@/app/components/CorpusDocsPanel";
import {
  getCorpus,
  listCorpusConfigs,
  listCorpusDocuments,
  listDocumentsNotInCorpus,
} from "@/lib/rag/corpusStore";

export const dynamic = "force-dynamic";

export default async function CorpusDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const corpus = await getCorpus(id);
  if (!corpus) notFound();

  const [documents, configs, availableDocuments] = await Promise.all([
    listCorpusDocuments(id),
    listCorpusConfigs(id),
    listDocumentsNotInCorpus(id),
  ]);
  const syncedCount = configs.filter((c) => c.corpusSync).length;

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-12">
        <Link
          href="/corpora"
          className="self-start text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← All corpora
        </Link>

        <header className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              {corpus.name}
            </h1>
            <CorpusDeleteButton
              corpusId={corpus.id}
              name={corpus.name}
              attachedConfigs={configs.length}
              redirectTo="/corpora"
            />
          </div>
          <p className="text-xs text-zinc-500">
            Created {new Date(corpus.createdAt).toLocaleDateString()} ·{" "}
            {documents.length} document{documents.length === 1 ? "" : "s"}
          </p>

          {/* Attached configs, auto-synced ones marked. */}
          {configs.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-xs uppercase tracking-wide text-zinc-400">
                Configs:
              </span>
              {configs.map((c) => (
                <Link
                  key={c.id}
                  href={`/c/${c.id}`}
                  title={
                    c.corpusSync
                      ? "Auto-sync on: corpus changes embed into / remove from this config"
                      : "Linked, auto-sync off: corpus changes don't affect this config"
                  }
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    c.corpusSync
                      ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
                      : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  }`}
                >
                  {c.corpusSync ? "⟳ " : ""}
                  {c.label}
                  {!c.isOpen && " (closed)"}
                </Link>
              ))}
            </div>
          ) : (
            <p className="pt-1 text-xs text-zinc-400">
              No configs attached. Create one over this corpus from the + tab (Existing
              corpora → {corpus.name}).
            </p>
          )}
          {syncedCount > 0 && (
            <p className="text-xs text-zinc-500">
              ⟳ = auto-synced: documents added here are embedded into that config
              (this costs embedding calls), and documents removed here are removed
              from it.
            </p>
          )}
        </header>

        <CorpusDocsPanel
          corpusId={corpus.id}
          documents={documents}
          availableDocuments={availableDocuments}
          syncedCount={syncedCount}
        />
      </main>
    </div>
  );
}
