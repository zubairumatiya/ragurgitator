// ---------------------------------------------------------------------------
// UI: chat container (Client Component).
//
// Owns conversation state, posts to /api/chat, renders <MessageList /> + an
// input box. No direct imports from lib/rag — server-only code stays server.
// ---------------------------------------------------------------------------
"use client";

import { useState } from "react";
import { MessageList, type DisplayMessage } from "@/app/components/MessageList";
import { apiFetch } from "@/lib/http/client";
import type { RetrievedChunk } from "@/types/rag";

type ChatResponse =
  | { answer: string; sources: RetrievedChunk[] }
  | { error: string };

export function ChatWindow() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function action(form: FormData) {
    const raw = form.get("question");
    const question = typeof raw === "string" ? raw.trim() : "";
    if (!question || loading) return;

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
          const message =
            "error" in data ? data.error : `Request failed (${res.status}).`;
          copy.push({ role: "assistant", content: `Error: ${message}` });
        } else {
          copy.push({
            role: "assistant",
            content: data.answer,
            sources: data.sources,
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

      <form action={action} className="flex gap-2">
        <input
          type="text"
          name="question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          placeholder="Ask something about your documents…"
          className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-black"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
