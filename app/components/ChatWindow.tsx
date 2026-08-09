// ---------------------------------------------------------------------------
// UI: chat container (Client Component).
//
// Owns conversation state, posts to /api/chat, renders <MessageList /> + an
// input box. No direct imports from lib/rag — server-only code stays server.
//
// `hasLlmKey` / `provider` come from the page (a Server Component), which reads
// them in the same request that renders this: under strict BYOK, "can I answer
// at all?" is a DB fact, and asking for it from here would mean a round trip and
// a window where Ask looks live and isn't. Both null-provider and true mean "let
// the request through" — see the page for why an unknown model isn't gated.
// ---------------------------------------------------------------------------
"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageList, type DisplayMessage } from "@/app/components/MessageList";
import { apiFetch } from "@/lib/http/client";
import { ACCOUNT_PATH, errorTextFrom, type MissingKeyFields } from "@/lib/http/missingKey";
import type { RetrievedChunk } from "@/types/rag";

type ChatResponse =
  | { answer: string; sources: RetrievedChunk[]; documents?: Record<string, string> }
  | ({ error: string } & MissingKeyFields);

export function ChatWindow({
  hasLlmKey = true,
  provider = null,
}: {
  hasLlmKey?: boolean;
  provider?: string | null;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // A plain onSubmit handler, not a <form action={fn}> passed a function:
  // React runs `action` functions inside an implicit transition, which
  // coalesces synchronous setState calls made before the first `await` with
  // whatever the action commits after it resolves — so the pending UI below
  // (loading=true, the "Thinking" bubble) never got a chance to paint before
  // the request that takes seconds to answer. onSubmit is a normal DOM event;
  // setState here flushes before the fetch begins.
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const raw = form.get("question");
    const question = typeof raw === "string" ? raw.trim() : "";
    if (!question || loading || !hasLlmKey) return;

    const next: DisplayMessage[] = [
      ...messages,
      { role: "user", content: question },
      { role: "assistant", content: "", pending: true },
    ];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as ChatResponse;

      setMessages((prev) => {
        const copy = prev.slice(0, -1);
        if (!res.ok || "error" in data) {
          // A chat bubble is a plain string, so this is the no-link half of the
          // missing-key contract — it still names the provider and the Account
          // page. See lib/http/missingKey.ts.
          const message = errorTextFrom(data, `Request failed (${res.status}).`);
          copy.push({ role: "assistant", content: `Error: ${message}` });
        } else {
          copy.push({
            role: "assistant",
            content: data.answer,
            sources: data.sources,
            documents: data.documents,
          });
        }
        return copy;
      });
    } catch (err) {
      setMessages((prev) => {
        const copy = prev.slice(0, -1);
        copy.push({
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Network error."}`,
        });
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <MessageList messages={messages} />

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          name="question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading || !hasLlmKey}
          placeholder={
            hasLlmKey
              ? "Ask something about your documents…"
              : `Add a ${provider ?? "provider"} key to ask questions`
          }
          className="flex-1 rounded border border-zinc-300 bg-transparent px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={loading || !input.trim() || !hasLlmKey}
          className="cursor-pointer rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>

      {/* Same phrasing as MissingKeyNotice, and the same link — this is the one
          place that knows about the missing key BEFORE a request is made, so it
          says it up front instead of letting the user type a question and lose
          it to an error bubble. */}
      {!hasLlmKey && (
        <p className="text-xs text-zinc-500">
          No {provider ?? "provider"} API key — this config answers with a {provider ?? "provider"}{" "}
          model.{" "}
          <Link href={ACCOUNT_PATH} className="underline underline-offset-2">
            Add your {provider ?? "provider"} key
          </Link>{" "}
          to ask questions.
        </p>
      )}
    </div>
  );
}
