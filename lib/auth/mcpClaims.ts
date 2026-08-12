// MCP TOKEN CLAIMS — the decision about which verified JWTs become an identity.
//
// Split out of lib/auth/mcpToken.ts, which is "server-only" because it holds the
// Supabase client. Everything here is pure: no imports, no I/O, no secrets — and a
// "server-only" module cannot be loaded by the test runner, so this is the code
// that most needs tests.
//
// THE CLIENT_ID CHECK IS THE SECURITY OF THE FEATURE. Read this before touching it.
// A browser session token — the one behind the cookie of anyone signed into the web
// app — is signed by the SAME project with the SAME key, so it passes signature
// verification here perfectly. If we accepted every validly-signed JWT, "having a
// session" and "having an MCP grant" would be the same thing, and any leaked cookie
// anywhere in the app would hand over the MCP surface for free. Only tokens minted
// by the OAuth server carry a `client_id` claim, so requiring it is what separates
// "this user approved an agent" from "this user is logged in". The first test in
// mcpClaims.test.ts is exactly this case; it is not optional.
//
// WHAT IS DELIBERATELY NOT CHECKED: scopes, and the RFC 8707 `resource` binding.
// Supabase issues only the standard OIDC scopes, so there is no `mcp:read` to
// require, and its tokens are not audience-bound to this server. Requiring a scope
// that is always present, or reading a `resource` claim that is never set, would
// look like defence and provide none.
import { type AuthInfo, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

// Identity lifted off the verified token and carried to the tool body through
// AuthInfo.extra. Deliberately the same two fields as RequestUser
// (lib/auth/userScope.ts) — producing one of these IS the whole auth swap, and
// everything downstream reads activeUserId() and never learns a token existed.
export type McpTokenIdentity = {
  userId: string;
  email: string;
};

// One message for every rejection. Distinguishing "expired" from "not an MCP
// token" from "bad signature" would tell an attacker which of those they got
// right, and tells a legitimate client nothing it can act on — the remedy is the
// same in all three cases: re-run the OAuth flow.
export const REJECTED = "Invalid or expired MCP access token.";

export const invalidToken = () => new OAuthError(OAuthErrorCode.InvalidToken, REJECTED);

// Takes ALREADY-VERIFIED claims. Calling it on unverified input would be
// meaningless — it trusts every field it reads.
export function authInfoFromClaims(token: string, claims: Record<string, unknown>): AuthInfo {
  // See the banner. This is the line that makes a browser session's token
  // useless here.
  const clientId = claims["client_id"];
  if (typeof clientId !== "string" || clientId.length === 0) throw invalidToken();

  // `sub` is guaranteed by the JWT spec, `email` is not — an anonymous or
  // phone-only user has none, and withUser() needs both. Reject rather than
  // invent a placeholder: an empty email would flow into RequestUser and out
  // through telemetry looking like a real address.
  const userId = claims["sub"];
  const email = claims["email"];
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    typeof email !== "string" ||
    email.length === 0
  ) {
    throw invalidToken();
  }

  // expiresAt MUST be populated: bearer verification rejects tokens whose expiry
  // is unset (it treats an unbounded token as a bug, correctly), so omitting it
  // here would reject every token with a thoroughly confusing message.
  const exp = claims["exp"];
  if (typeof exp !== "number") throw invalidToken();

  const scope = claims["scope"];

  return {
    token,
    clientId,
    scopes: typeof scope === "string" && scope.length > 0 ? scope.split(" ") : [],
    expiresAt: exp,
    extra: { userId, email } satisfies McpTokenIdentity,
  };
}

// Narrow AuthInfo.extra back to the identity we put there. The SDK types `extra`
// as Record<string, unknown>, so the route re-checks rather than casts — a miss
// here means a wiring bug, not a hostile token, since the token was verified
// long before anything reads this.
export function mcpIdentity(extra: Record<string, unknown> | undefined): McpTokenIdentity | null {
  const userId = extra?.userId;
  const email = extra?.email;
  if (typeof userId !== "string" || typeof email !== "string") return null;
  return { userId, email };
}
