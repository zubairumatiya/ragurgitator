// ---------------------------------------------------------------------------
// Bridge between the HTTP layer and the active-config scope. Every route handler
// runs its work inside withRequestConfig so the store layer can read
// activeConfig() (see lib/rag/activeConfig.ts).
//
// configId travels in via a `configId` query param or `x-config-id` header; with
// no tabs UI yet (Phase 1) requests don't send one and fall back to the Default
// config. For NDJSON streaming routes the scope is captured into the stream
// producer by lib/http/ndjson.ts, so wrapping the handler body is enough.
// ---------------------------------------------------------------------------
import { resolveRequestConfig, withConfig } from "@/lib/rag/activeConfig";

export async function withRequestConfig<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<T> {
  const cfg = await resolveRequestConfig(request);
  return withConfig(cfg, fn);
}
