// Playground (was app/page.tsx) — now scoped to the active config. The tab bar,
// banner, and sub-nav live in the layout; this page renders just its content.
import { ChatWindow } from "@/app/components/ChatWindow";
import { DocumentList } from "@/app/components/DocumentList";
import { FileUpload } from "@/app/components/FileUpload";

export default function PlaygroundPage() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          RAG playground
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Upload a document, then ask questions about it.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          1. Ingest
        </h2>
        <FileUpload />
        <DocumentList />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          2. Ask
        </h2>
        <ChatWindow />
      </section>
    </>
  );
}
