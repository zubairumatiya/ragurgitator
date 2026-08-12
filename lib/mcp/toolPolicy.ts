// MCP TOOL POLICY — the decisions the four Phase 2 tools make before touching the
// database, kept in a module the test runner can load.
//
// Same split as writeGrantPolicy.ts against writeGrant.ts: the tool bodies are
// "server-only" because they hold `sql` and the store layer, so the parts worth
// testing — how big a page may be, whether a base model can actually be built on,
// what a denied write should tell the caller to do — live here instead.
//
// The one non-obvious member is approvalUrl. A write tool that fails with a bare
// "forbidden" leaves the model guessing; a write tool that answers with the exact
// link its user must open turns a refusal into a next step. That link is composed
// here rather than in each tool so the query-parameter names stay in step with
// app/account/mcp-write/page.tsx, which reads them.

import type { WriteCapability } from "@/lib/mcp/writeGrantPolicy";

// Page sizes for list_chunks. The cap is about the MODEL, not the database: a
// 50-chunk page is already several thousand tokens of passage text, and a tool
// that will happily return the whole corpus in one call invites exactly that.
export const DEFAULT_CHUNK_PAGE = 25;
export const MAX_CHUNK_PAGE = 50;

// Batch ceiling for add_questions. insertQuestionWithLabel opens a transaction
// per question, so an unbounded batch is a long-running write held open by
// whatever the model felt like sending.
export const MAX_QUESTION_BATCH = 50;

// Clamp rather than reject. An out-of-range limit is the model misreading the
// schema, not an attack, and refusing the call costs a round trip to teach it
// something the description already said.
export function chunkPage(offset?: number, limit?: number): { offset: number; limit: number } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset!)) : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(MAX_CHUNK_PAGE, Math.max(1, Math.trunc(limit!)))
    : DEFAULT_CHUNK_PAGE;
  return { offset: safeOffset, limit: safeLimit };
}

// null means "that was the last page", which is what stops a paging loop. Derived
// from the returned row count rather than from a total, so it can never point past
// the end of a list that shrank between calls.
export function nextOffset(offset: number, limit: number, returned: number): number | null {
  return returned < limit ? null : offset + returned;
}

// Whether a base model can actually carry a config: it needs a vector table AND a
// resolvable provider key right now. Mirrors the guard in app/api/configs/route.ts
// deliberately — an MCP tool that skipped it would be a way to create configs that
// can never embed anything, which fails later, elsewhere, and confusingly.
export type SelectableOption = { id: string; selectable: boolean; reason: string | null };

export function baseModelRefusal(
  options: SelectableOption[],
  baseModel: string,
): string | null {
  const option = options.find((o) => o.id === baseModel);
  if (!option) {
    const known = options
      .filter((o) => o.selectable)
      .map((o) => o.id)
      .join(", ");
    return `"${baseModel}" isn't a known base model. Selectable right now: ${known || "none"}.`;
  }
  if (!option.selectable) {
    return option.reason ?? `"${baseModel}" isn't a selectable base model.`;
  }
  return null;
}

// The link the user opens to approve a write. `exp` is the caller's own token
// expiry, passed through so the grant can be capped by it; the page treats every
// parameter as a proposal and re-derives the decision from its checkboxes.
export function approvalUrl(
  siteUrl: string,
  clientId: string,
  capabilities: WriteCapability[],
  tokenExpSeconds?: number,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    capabilities: capabilities.join(","),
  });
  if (typeof tokenExpSeconds === "number" && Number.isFinite(tokenExpSeconds)) {
    params.set("exp", String(Math.trunc(tokenExpSeconds)));
  }
  return `${siteUrl.replace(/\/+$/, "")}/account/mcp-write?${params}`;
}

// THE PARTIAL-FAILURE RULE for add_questions, kept here so it can be tested
// without a database: resolution and insertion are injected, the sequencing and
// the per-item verdicts are not.
//
// One stale chunk id in a batch of fifty must not discard the forty-nine good
// questions. If it did, the model's only recovery would be to resend all fifty —
// and the resend would hit the same bad id, so the batch would never land.
export type BatchItem = { chunkId: string };

export type BatchOutcome = {
  chunkId: string;
  ok: boolean;
  questionId?: string;
  error?: string;
};

export const UNKNOWN_CHUNK =
  "No such chunk in this config. Chunk ids are per-config; re-read them with list_chunks.";

export async function settleBatch<T extends BatchItem>(
  items: T[],
  isResolvable: (chunkId: string) => boolean,
  insert: (item: T) => Promise<string>,
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = [];
  for (const item of items) {
    // An id belonging to another config, to a deleted document, or to nothing at
    // all are indistinguishable on purpose — the same reason describeConfig
    // collapses "not found" into "not yours".
    if (!isResolvable(item.chunkId)) {
      outcomes.push({ chunkId: item.chunkId, ok: false, error: UNKNOWN_CHUNK });
      continue;
    }
    try {
      outcomes.push({ chunkId: item.chunkId, ok: true, questionId: await insert(item) });
    } catch (err) {
      // Each insert is its own transaction, so a failure loses exactly this
      // question. Catching per item is what keeps that true.
      outcomes.push({
        chunkId: item.chunkId,
        ok: false,
        error: err instanceof Error ? err.message : "Insert failed.",
      });
    }
  }
  return outcomes;
}

// What a denied write says. Names the capability, because a user who approved
// "write eval questions" and then sees a config_create refusal should be able to
// tell the two apart without reading the source.
export function writeDeniedMessage(capability: WriteCapability, url: string): string {
  return (
    `This account has not approved "${capability}" for this client, or the approval has ` +
    `expired (approvals last at most an hour). Ask the user to open ${url} and approve it, ` +
    `then retry.`
  );
}
