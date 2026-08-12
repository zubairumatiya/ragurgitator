// MCP BEARER TOKEN VERIFICATION — the resource server's half of the OAuth flow.
//
// Supabase is the AUTHORIZATION server: it runs the OAuth 2.1 endpoints, handles
// dynamic client registration, and mints the tokens. We are the RESOURCE server,
// which reduces to one job — decide whether the bearer token on this request is
// real, and whose it is.
//
// This file is the SIGNATURE half; lib/auth/mcpClaims.ts is the DECISION half, and
// the security argument lives over there with the code it describes. The split
// exists because this module holds a Supabase client and is "server-only", which
// makes it unloadable by the test runner — and the decision logic most needs tests.
//
// TWO CHECKS, in this order, and the order is the whole design:
//
//   1. getClaims(token) — LOCAL signature verification against the cached JWKS. No
//      network. Rejects garbage, forgeries and expired tokens for free, so a junk
//      token should not cost a round trip. (Local only while the project signs
//      with an ASYMMETRIC key; under HS256 this silently becomes a round trip of
//      its own, which is why the dashboard checklist insists on ES256.)
//   2. getUser(token) — SESSION LIVENESS, one round trip to the auth server.
//
// WHY STEP 2 EXISTS, since it costs a round trip on every MCP request. A signature
// says the token was issued and has not expired. It says NOTHING about whether the
// grant behind it still exists. Measured 2026-08-12 against a live token: after
// auth.oauth.revokeGrant(), getClaims still ACCEPTED the token while getUser
// REJECTED it. So with local verification alone, the Disconnect button on /account
// was advisory for up to the access-token TTL — one hour — and a leaked token
// stayed live that whole window. Revocation you have to wait an hour for is not
// revocation.
//
// THE MEASURED COST (same machine, 2026-08-12, dev server against remote Supabase):
//
//   getClaims  (local signature)    ~1 ms
//   getUser    (session liveness)   ~143 ms   <- this check
//   mcp_enabled (kill switch query)  ~64 ms
//   whole tools/list request        ~495 ms
//
// Roughly a third of the request, on requests that happen when a human asks an
// agent a question — not a hot loop. The round trip also only happens for tokens
// that already passed local verification. If MCP traffic ever became chatty enough
// for this to hurt, the move is a short-TTL liveness cache keyed on the token, NOT
// dropping the check.
import "server-only";

import { type AuthInfo, OAuthError, type OAuthTokenVerifier } from "@modelcontextprotocol/server";

import { authInfoFromClaims, invalidToken } from "@/lib/auth/mcpClaims";
import { tokenSupabase } from "@/lib/auth/supabase";

export { type McpTokenIdentity, mcpIdentity } from "@/lib/auth/mcpClaims";

export const mcpTokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const supabase = tokenSupabase();

    let claims: Record<string, unknown>;
    try {
      const { data, error } = await supabase.auth.getClaims(token);
      if (error || !data) throw invalidToken();
      claims = data.claims as Record<string, unknown>;
    } catch (err) {
      // Rethrow our own rejection untouched; anything else (network failure,
      // malformed JWKS, a thrown parse error) becomes the same 401 rather than a
      // 500. A verifier that 500s on a garbage token tells the caller the server
      // is broken when in fact the token is.
      if (OAuthError.isInstance(err)) throw err;
      throw invalidToken();
    }

    const authInfo = authInfoFromClaims(token, claims);

    // Liveness. See the banner: this is what makes Disconnect take effect on the
    // next request rather than at token expiry. Deliberately AFTER the local
    // checks, so a malformed or expired token never reaches the network.
    try {
      const { error } = await supabase.auth.getUser(token);
      if (error) throw invalidToken();
    } catch (err) {
      if (OAuthError.isInstance(err)) throw err;
      throw invalidToken();
    }

    return authInfo;
  },
};
