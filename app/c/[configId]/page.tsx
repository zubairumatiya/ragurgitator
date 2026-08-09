// Workbench (was app/page.tsx) — now scoped to the active config. The tab bar,
// banner, and sub-nav live in the layout; this page renders just its content.
//
// A Server Component, so the "can this user actually generate an answer?" check
// is done HERE and passed down as props: under strict BYOK the answer is a DB
// read (availableProviders), and doing it in the client would mean a round trip
// plus a moment where the Ask button looks usable and isn't. The gate is on the
// config's OWN provider — an account with only an OpenAI key still can't run a
// config set to Claude, so "has any key" would be the wrong question.
import { ChatWindow } from "@/app/components/ChatWindow";
import { DocumentList } from "@/app/components/DocumentList";
import { FileUpload } from "@/app/components/FileUpload";
import { withPageUser } from "@/lib/auth/dal";
import { llmProviderFor } from "@/lib/llm/llmModels";
import { getConfig } from "@/lib/rag/configStore";
import { availableProviders } from "@/lib/rag/providerAvailability";

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ configId: string }>;
}) {
  const { configId } = await params;
  const { provider, hasLlmKey } = await withPageUser(async () => {
    const [config, available] = await Promise.all([getConfig(configId), availableProviders()]);
    // An unrecognised model id (llmProviderFor → null) means we cannot say which
    // key it needs, so we don't gate: better to let the request run and surface
    // the provider's own error than to disable the button on a guess. The
    // layout 404s a missing config, so `config` is only null in the sliver
    // before that lands.
    const provider = config ? llmProviderFor(config.llmModel) : null;
    return { provider, hasLlmKey: provider === null || available.has(provider) };
  });

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Config workbench
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
        <ChatWindow hasLlmKey={hasLlmKey} provider={provider} />
      </section>
    </>
  );
}
