// ---------------------------------------------------------------------------
// CONFIG-SCOPED fetch wrapper for client components.
//
// Pages live under /c/<configId>/… (see app/c/[configId]). Every /api/… call a
// client makes must be scoped to the config of the tab it's on, otherwise the
// store layer falls back to the Default config (resolveRequestConfig in
// lib/rag/activeConfig.ts). Rather than thread configId through every component,
// apiFetch reads it from the current URL path and injects ?configId=… so the
// API route resolves the right ResolvedConfig.
//
// NOTE: this is the BROWSER fetch wrapper. It is unrelated to lib/llm/client.ts
// (the server-side Anthropic client). Only import this from "use client" code.
// ---------------------------------------------------------------------------

// The active tab's configId, parsed from /c/<id>/… ; null when off a config
// route (e.g. the Appraise page) or during SSR where there's no location.
export function currentConfigId(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Drop-in replacement for fetch() that scopes /api/… requests to the active tab.
// Non-API URLs (or calls made off a config route) pass straight through, so this
// is safe to use everywhere a component talks to the backend.
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const configId = currentConfigId();
  if (configId && input.startsWith("/api/")) {
    const sep = input.includes("?") ? "&" : "?";
    input = `${input}${sep}configId=${encodeURIComponent(configId)}`;
  }
  return fetch(input, init);
}
