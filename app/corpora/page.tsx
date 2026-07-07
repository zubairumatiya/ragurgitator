// Corpora — the "My corpora" management page (linked from the sidebar). Lists
// every corpus, including empty ones (a just-created corpus has no docs yet),
// each linking to its detail page (/corpora/[id]) for doc management. The
// create form can start empty or merge existing corpora (de-duped). Standalone
// (outside /c/[configId]) like Appraise, so no per-config banner/sub-nav.
// Dynamic — it reads the DB per request.
import Link from "next/link";
import { CorpusCreateForm } from "@/app/components/CorpusCreateForm";
import { CorpusDeleteButton } from "@/app/components/CorpusDeleteButton";
import { listCorpora } from "@/lib/rag/corpusStore";

export const dynamic = "force-dynamic";

export default async function CorporaPage() {
  const corpora = await listCorpora({ includeEmpty: true });

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-12">
        <Link
          href="/"
          className="self-start text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to configs
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            My corpora
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            A corpus is a reusable, named selection of documents — a quick way to pick a
            doc set when creating configs. Corpora and configs are independent: deleting
            a corpus never touches a config&apos;s documents. A config can{" "}
            <em>auto-sync</em> with its corpus so membership changes flow both ways.
          </p>
        </header>

        <CorpusCreateForm corpora={corpora} />

        {corpora.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No corpora yet. Create one above — then add documents on its page, or let a
            synced config&apos;s uploads fill it.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Documents</th>
                  <th className="px-3 py-2 text-right font-medium">Configs</th>
                  <th className="px-3 py-2 text-right font-medium">Created</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {corpora.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-900"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/corpora/${c.id}`}
                        className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {c.name}
                      </Link>
                      {c.docCount === 0 && (
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-normal text-zinc-500 dark:bg-zinc-900">
                          empty
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {c.docCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {c.configCount}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-500">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <CorpusDeleteButton
                        corpusId={c.id}
                        name={c.name}
                        attachedConfigs={c.configCount}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
