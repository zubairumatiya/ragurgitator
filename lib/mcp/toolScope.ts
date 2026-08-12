// THE CONFIG SCOPE FOR MCP TOOLS — the hop withMcpUser deliberately does not make.
//
// lib/http/mcpScope.ts opens a USER scope from a bearer token, and stops there: an
// MCP request carries no URL to read `configId` out of, so there is nothing for it
// to resolve. Meanwhile most of the store layer reads activeConfig() out of
// AsyncLocalStorage and throws outside a withConfig scope.
//
// That gap is the whole reason this file exists. Every config-scoped tool takes an
// explicit configId and routes it through here, which is the JSON-RPC counterpart
// of a route handler's `withConfig(await resolveRequestConfig(req), …)`.
//
// NOT FOUND AND NOT YOURS ARE THE SAME ANSWER, matching describeConfig.ts:
// resolveConfig filters on activeUserId() and returns null for a missing row, a
// malformed uuid and another account's config alike. Splitting them here would
// turn every tool into an oracle for which config ids exist elsewhere.
import "server-only";

import { withConfig, resolveConfig } from "@/lib/rag/activeConfig";

export const NO_SUCH_CONFIG =
  "No config with that id. Call describe_config with no arguments to list them.";

export async function withToolConfig<T>(
  configId: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const resolved = await resolveConfig(configId);
  if (!resolved) return { ok: false, error: NO_SUCH_CONFIG };
  return { ok: true, value: await withConfig(resolved, fn) };
}
