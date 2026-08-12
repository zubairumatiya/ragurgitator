// MCP WRITE GRANTS — the store half (migrations/0060_mcp_write_grants.sql).
//
// Every function here runs inside a request scope: `sql` throws outside one, and
// RLS on mcp_write_grants keys on user_id, so a query that forgot its predicate
// returns nothing rather than someone else's grants. The explicit `user_id =`
// clauses are belt to that braces — the same posture the rest of the store takes.
//
// WHY THIS TAKES userId EXPLICITLY rather than reading activeUserId(). Two of the
// four callers are Server Actions on a session cookie and two are MCP tool bodies
// on a bearer token; passing the id keeps this file indifferent to which, exactly
// as lib/http/mcpScope.ts's header describes for the layer below it.
//
// The decisions — which capabilities exist, how long a grant may last, whether a
// given grant authorizes a given call — are NOT here. They live in
// writeGrantPolicy.ts so tests can load them without "server-only".
import "server-only";

import { sql } from "@/lib/db";
import { type WriteCapability, type WriteGrant, grantAllows } from "@/lib/mcp/writeGrantPolicy";

type GrantRow = {
  client_id: string;
  capabilities: string[];
  granted_at: Date;
  expires_at: Date;
};

const toGrant = (row: GrantRow): WriteGrant => ({
  clientId: row.client_id,
  capabilities: row.capabilities,
  grantedAt: row.granted_at,
  expiresAt: row.expires_at,
});

// Upsert, because the primary key is (user_id, client_id): re-approving REPLACES
// the capability set rather than unioning it. That direction is deliberate — an
// approval screen showing two boxes with one ticked has to be able to take a
// capability away, and a union would make "approve" a one-way ratchet the user
// could never walk back except by revoking outright.
//
// granted_at is refreshed too, so /account reads "approved at" rather than
// "first ever approved at".
export async function grantWrite(
  userId: string,
  clientId: string,
  capabilities: WriteCapability[],
  expiresAt: Date,
): Promise<void> {
  await sql`
    insert into mcp_write_grants (user_id, client_id, capabilities, expires_at)
    values (${userId}, ${clientId}, ${sql.array(capabilities as string[])}, ${expiresAt})
    on conflict (user_id, client_id) do update
      set capabilities = excluded.capabilities,
          granted_at   = now(),
          expires_at   = excluded.expires_at
  `;
}

// THE AUTHORIZATION CHECK every write tool calls first.
//
// Expiry is filtered in SQL on the database clock AND re-checked in grantAllows
// on the app clock. Belt and braces on purpose: this is the function standing
// between a bearer token and a row, and the cost of the redundancy is nothing.
export async function hasCapability(
  userId: string,
  clientId: string,
  capability: WriteCapability,
): Promise<boolean> {
  const rows = await sql<GrantRow[]>`
    select client_id, capabilities, granted_at, expires_at
    from mcp_write_grants
    where user_id = ${userId} and client_id = ${clientId} and expires_at > now()
  `;
  const grant = rows[0] ? toGrant(rows[0]) : null;
  return grantAllows(grant, capability, Date.now());
}

// For describe_authorization and the approval page: the grant as it stands,
// INCLUDING an expired one. A lapsed grant is the answer to "why did my write
// just fail", so hiding it behind the same filter hasCapability uses would turn
// the most common failure into a silent one. Callers decide what to do with a
// past expires_at (grantIsLive says which it is).
export async function describeGrant(
  userId: string,
  clientId: string,
): Promise<WriteGrant | null> {
  const rows = await sql<GrantRow[]>`
    select client_id, capabilities, granted_at, expires_at
    from mcp_write_grants
    where user_id = ${userId} and client_id = ${clientId}
  `;
  return rows[0] ? toGrant(rows[0]) : null;
}

// Every grant on the account, live or lapsed, newest first — what /account shows
// so "which agents can write to my data" has one place to look.
export async function listGrants(userId: string): Promise<WriteGrant[]> {
  const rows = await sql<GrantRow[]>`
    select client_id, capabilities, granted_at, expires_at
    from mcp_write_grants
    where user_id = ${userId}
    order by granted_at desc
  `;
  return rows.map(toGrant);
}

// Delete rather than expire-in-place. Revoking is the user saying "not this
// client", and leaving a tombstone that hasCapability would ignore anyway only
// invites a future reader to wonder whether it means something.
export async function revokeWrite(userId: string, clientId: string): Promise<void> {
  await sql`
    delete from mcp_write_grants where user_id = ${userId} and client_id = ${clientId}
  `;
}
