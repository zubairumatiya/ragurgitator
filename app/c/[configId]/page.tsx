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
import { isGuest } from "@/lib/demo/guest";
import { llmProviderFor } from "@/lib/llm/llmModels";
import { resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { availableProviders } from "@/lib/rag/providerAvailability";
import { bankedQuestions } from "@/lib/rag/semanticCache";

// The demo's suggestion chips. bankedQuestions() reads the active config out of
// AsyncLocalStorage, and withPageUser only establishes the USER scope — so this
// needs its own withConfig or it throws before the page renders anything.
//
// Best-effort on purpose, and the wider version of the promise bankedQuestions
// already makes internally: no chips is a correct answer, so nothing about a
// list of suggestions may be what takes the workspace down. That is not
// hypothetical — a missing config scope here 500'd every guest workspace while
// /demo itself kept answering 200, because the failure was entirely behind the
// button.
async function guestSuggestions(configId: string): Promise<string[]> {
  try {
    const cfg = await resolveConfig(configId);
    if (!cfg) return [];
    return await withConfig(cfg, () => bankedQuestions());
  } catch (err) {
    console.warn(`[demo] suggestion chips unavailable: ${(err as Error).message}`);
    return [];
  }
}

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ configId: string }>;
}) {
  const { configId } = await params;
  const { provider, hasLlmKey, suggestions } = await withPageUser(async () => {
    const [config, available, guest] = await Promise.all([
      getConfig(configId),
      availableProviders(),
      isGuest(),
    ]);
    // An unrecognised model id (llmProviderFor → null) means we cannot say which
    // key it needs, so we don't gate: better to let the request run and surface
    // the provider's own error than to disable the button on a guess. The
    // layout 404s a missing config, so `config` is only null in the sliver
    // before that lands.
    const provider = config ? llmProviderFor(config.llmModel) : null;
    // A GUEST HAS NO ANSWER-MODEL KEY AND MUST STILL BE ABLE TO ASK. Gating the
    // box on `available.has(provider)` would disable the one thing the demo
    // exists to show — and it would be wrong, because a cache hit skips
    // generation entirely, so the key it is checking for is not needed for the
    // question they are about to ask. The miss path is handled in the chat
    // route, which words it as "no answer key in the demo — try one of these"
    // rather than as a link to /account they cannot use.
    const hasLlmKey = guest || provider === null || available.has(provider);
    // Only the demo gets chips. A real account's own questions are already in
    // their history, and offering a signed-in user their own cached queries as
    // "suggestions" would read as the app running out of ideas.
    const suggestions = guest ? await guestSuggestions(configId) : [];
    return { provider, hasLlmKey, suggestions };
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
        <ChatWindow hasLlmKey={hasLlmKey} provider={provider} suggestions={suggestions} />
      </section>
    </>
  );
}
