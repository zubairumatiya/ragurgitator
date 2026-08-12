// THE MCP REQUEST SCOPE — the bearer-token sibling of withRequestUser.
//
// lib/http/configScope.ts opens a request scope from a session COOKIE. This file
// opens the same scope from a verified bearer TOKEN, and that is the entire
// difference between them. Both end up doing the identical three things in the
// identical order:
//
//     withDetachedQueue(user, after, () => withUser(user, () => catchingMissingKey(fn)))
//
// THE ORDERING IS LOAD-BEARING, not stylistic. withDetachedQueue calls its
// `schedule` argument — Next's after() — at the TOP of its body, before
// pending.run() invokes fn (lib/detached.ts:110-125). That is what guarantees
// the async context Next binds for the flush carries no open transaction handle.
// Flip after() inside withUser and the deferred writes inherit a transaction
// that has already committed by the time they run, which fails silently rather
// than loudly. See the banner at lib/http/configScope.ts:21-24, and the
// AsyncResource.bind note in lib/http/ndjson.ts for the same trap in the
// streaming case.
//
// WHY THIS IS SAFE TO ADD AT ALL — i.e. why swapping the credential doesn't
// require auditing the store layer. Nothing below this line ever reads a cookie.
// RLS reads set_config('app.user_id') set by withUser (lib/db.ts:119), the store
// layer's predicates read activeUserId() out of AsyncLocalStorage, and BYOK key
// resolution takes an explicit userId. All three are downstream of a RequestUser
// and indifferent to where it came from, so producing one from JWT claims is the
// whole of the integration. That property is worth protecting: if some future
// code path starts reading cookies() to decide what a user may see, this file
// quietly stops being equivalent to its sibling.
import "server-only";

import { type AuthInfo, requireBearerAuth } from "@modelcontextprotocol/server";
import { after } from "next/server";

import { mcpIdentity, mcpTokenVerifier } from "@/lib/auth/mcpToken";
import { type RequestUser, activeUserId, withUser } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { withDetachedQueue } from "@/lib/detached";
import { catchingMissingKey } from "@/lib/http/configScope";
import { resourceMetadataUrl } from "@/lib/mcp/metadata";

// Authenticate happens BEFORE this — requireBearerAuth + mcpTokenVerifier have
// already run by the time a caller has a RequestUser to pass in, which is why
// this takes the user rather than the request. The cookie wrappers can't do that
// because the cookie jar is ambient; a token is not.
export function withMcpUser<T>(user: RequestUser, fn: () => Promise<T>): Promise<T | Response> {
  return withDetachedQueue(user, after, () => withUser(user, () => catchingMissingKey(fn)));
}

// The kill switch (migrations/0059_mcp_access.sql). Must be called INSIDE a
// scope: `sql` throws outside one, and RLS on user_profiles keys on `id` rather
// than the usual `user_id`, so this reads the caller's own row and could not
// read anyone else's even if the predicate were wrong.
//
// Missing row → false, not a throw. A user with no profile row has certainly not
// opted in, and "off" is the safe reading of an ambiguous state for a switch
// whose entire job is to deny.
async function mcpEnabled(): Promise<boolean> {
  const rows = await sql<{ mcp_enabled: boolean }[]>`
    select mcp_enabled from user_profiles where id = ${activeUserId()}
  `;
  return rows[0]?.mcp_enabled ?? false;
}

// THE HTTP BOUNDARY for /api/mcp — the exact counterpart of withRequestUser in
// configScope.ts, and registered in scripts/guards.ts by name for the same
// reason: a route handler is only as authenticated as the named gate its body
// reaches, and this is that gate.
//
// Three refusals before `fn` ever runs, in increasing cost order:
//
//   1. requireBearerAuth — no token, bad signature, no client_id, expired.
//      Answers with a fully-formed RFC 9728 challenge carrying
//      resource_metadata, which is how a cold client bootstraps. Returning our
//      own tidier 401 here would break discovery at step one.
//   2. mcpIdentity — the verified token carries no usable sub/email. Not
//      reachable through mcpTokenVerifier, which already rejects those; this
//      catches a future verifier that forgets.
//   3. mcpEnabled — the account-wide kill switch (0059).
//
// The kill switch is checked HERE, at the boundary, rather than inside the tool.
// That is deliberate: flipping it off has to refuse `initialize` and
// `tools/list` too, because an "off" server that still lets a client enumerate
// the tool surface and confirm the account exists is a strange sort of off. The
// price is one single-row transaction per request, which is the right trade for
// a switch whose entire job is to deny.
const gate = requireBearerAuth({
  verifier: mcpTokenVerifier,
  resourceMetadataUrl: resourceMetadataUrl(),
});

const forbidden = (message: string) => Response.json({ error: message }, { status: 403 });

export async function withMcpRequest(
  request: Request,
  fn: (auth: AuthInfo, user: RequestUser) => Promise<Response>,
): Promise<Response> {
  const auth = await gate(request);
  if (auth instanceof Response) return auth;

  const identity = mcpIdentity(auth.extra);
  if (!identity) return forbidden("This token carries no usable identity.");

  const user: RequestUser = { id: identity.userId, email: identity.email };

  const enabled = await withMcpUser(user, () => mcpEnabled());
  // withMcpUser's union return: only the missing-provider-key path produces a
  // Response, which a single-column select cannot reach — but returning it is
  // still the correct thing to do with one if it ever appears.
  if (enabled instanceof Response) return enabled;
  if (!enabled) {
    return forbidden(
      "MCP access is turned off for this account. Enable it under Account → MCP access.",
    );
  }

  return fn(auth, user);
}
