// THE PER-GUEST EMBEDDING BUDGET — what turns "bounded" into "small".
//
// The policy gate (lib/demo/policy.ts) already makes a guest's spend bounded: it
// blocks every lever that buys embeddings in bulk. What it cannot bound is the
// slow drip — a visitor asking questions in a loop, each one embedding its query
// — because that IS the demo and cannot be switched off. This is the ceiling on
// that, and its second job is to make exhaustion LEGIBLE: a "demo budget spent"
// panel rather than a provider 401 arriving from three layers down.
//
// MEASURED FROM THE LEDGER, NOT A COUNTER. provider_key_usage (0072) already
// records one row per call with its token counts, written by the same adapters
// that make the call. A second counter would be a second thing to keep in
// agreement with the provider's own numbers, and the ledger's whole purpose is
// to be the half of that comparison we control.
//
// The read is one indexed aggregate over rows the guest wrote in the last couple
// of hours — a handful, not a table scan, because the workspace is deleted long
// before the ledger grows.
import "server-only";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { demo } from "@/lib/demo/config";
import { isGuest } from "@/lib/demo/guest";
import { DemoBlockedError } from "@/lib/demo/policy";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// Embedding tokens this guest has spent. Counts input tokens only: an embedding
// call returns vectors, not tokens, so output_tokens is 0 on every row and
// summing it would only suggest otherwise.
export async function embedTokensSpent(): Promise<number> {
  try {
    const [row] = await sql<{ n: string }[]>`
      select coalesce(sum(input_tokens), 0)::text as n
        from provider_key_usage
       where user_id = ${activeUserId()} and kind = 'embed'
    `;
    return Number(row?.n ?? 0);
  } catch (err) {
    // Before 0072 the ledger does not exist. A budget that cannot be measured
    // must not become a budget of zero.
    if (isMissingTable(err)) return 0;
    throw err;
  }
}

// Called at the ONE dispatcher every embedding goes through (lib/rag/embeddings
// embed()), so no provider and no caller can route around it.
//
// CHECKED BEFORE THE CALL, NOT AFTER, so the last request over the line costs
// one batch rather than being refused after it has already been paid for. The
// consequence is that the budget is a floor the guest can overshoot by at most
// one batch, which is the right way round.
//
// A no-op for everyone else, and the isGuest() read is React-cached per request,
// so a real account pays nothing for this living on the hot path.
export async function assertDemoEmbedBudget(): Promise<void> {
  if (!(await isGuest())) return;
  if ((await embedTokensSpent()) >= demo.embedTokenBudget) {
    throw new DemoBlockedError("budget");
  }
}
