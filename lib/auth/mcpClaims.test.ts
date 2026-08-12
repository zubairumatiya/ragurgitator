// Contract tests for the MCP bearer-token decision (lib/auth/mcpClaims.ts) —
// which verified JWTs become an MCP identity and which are refused. No network
// and no live project: authInfoFromClaims takes already-verified claims, so the
// signature check is Supabase's problem and everything else is testable here.
// (The claims logic lives in its own module precisely so this file can import
// it — lib/auth/mcpToken.ts is "server-only" and the runner cannot load it.)
//
// THE FIRST TEST IS THE IMPORTANT ONE. A browser session token for this project
// is signed by the same key as an MCP token and passes signature verification
// perfectly; the only thing separating them is the client_id claim. If that
// check is ever removed, "logged into the web app" silently becomes "holds an
// MCP grant", and this test is what should fail. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { authInfoFromClaims, mcpIdentity } from "./mcpClaims";

// What Supabase actually puts in a token minted by the OAuth server.
const mcpClaims = {
  sub: "11111111-1111-1111-1111-111111111111",
  email: "someone@example.com",
  exp: 1_800_000_000,
  client_id: "22222222-2222-2222-2222-222222222222",
  scope: "openid email",
};

// The same project's ORDINARY session token: same shape, same signer, no
// client_id. This is the impersonation attempt the check exists to stop.
const sessionClaims = {
  sub: "11111111-1111-1111-1111-111111111111",
  email: "someone@example.com",
  exp: 1_800_000_000,
  role: "authenticated",
  session_id: "33333333-3333-3333-3333-333333333333",
};

const rejects = (claims: Record<string, unknown>) =>
  assert.throws(() => authInfoFromClaims("tok", claims), /Invalid or expired MCP access token/);

test("a browser session token is refused: no client_id, no MCP access", () => {
  rejects(sessionClaims);
  // Belt and braces — an empty or non-string client_id is not a client_id.
  rejects({ ...mcpClaims, client_id: "" });
  rejects({ ...mcpClaims, client_id: 42 });
});

test("an OAuth-server token maps to the identity the scope needs", () => {
  const auth = authInfoFromClaims("tok", mcpClaims);
  assert.equal(auth.token, "tok");
  assert.equal(auth.clientId, mcpClaims.client_id);
  assert.deepEqual(auth.scopes, ["openid", "email"]);
  // Must be set: bearer verification rejects tokens whose expiry is unset.
  assert.equal(auth.expiresAt, mcpClaims.exp);
  assert.deepEqual(auth.extra, { userId: mcpClaims.sub, email: mcpClaims.email });
});

test("no usable subject or email is a rejection, never a placeholder", () => {
  rejects({ ...mcpClaims, sub: undefined });
  rejects({ ...mcpClaims, sub: "" });
  // An anonymous or phone-only user: valid token, but withUser() needs an email
  // and inventing one would put a fake address into telemetry.
  rejects({ ...mcpClaims, email: undefined });
  rejects({ ...mcpClaims, email: "" });
});

test("a token with no expiry is refused rather than treated as unbounded", () => {
  rejects({ ...mcpClaims, exp: undefined });
  rejects({ ...mcpClaims, exp: "1800000000" });
});

test("a missing scope claim is an empty list, not a failure", () => {
  // Supabase does not always populate `scope`, and its absence says nothing
  // about validity — we require no scopes, so there is nothing to refuse over.
  assert.deepEqual(authInfoFromClaims("tok", { ...mcpClaims, scope: undefined }).scopes, []);
  assert.deepEqual(authInfoFromClaims("tok", { ...mcpClaims, scope: "" }).scopes, []);
});

test("mcpIdentity narrows only a well-formed extra", () => {
  assert.deepEqual(mcpIdentity({ userId: "u", email: "e" }), { userId: "u", email: "e" });
  assert.equal(mcpIdentity(undefined), null);
  assert.equal(mcpIdentity({}), null);
  assert.equal(mcpIdentity({ userId: "u" }), null);
  assert.equal(mcpIdentity({ userId: 1, email: "e" }), null);
});
