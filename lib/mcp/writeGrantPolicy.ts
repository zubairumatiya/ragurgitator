// MCP WRITE GRANTS — the pure half: what a capability is, and when a grant is live.
//
// Split from writeGrant.ts for the same reason mcpClaims.ts is split from
// mcpToken.ts: that file is "server-only" because it holds the database handle,
// and a "server-only" module cannot be loaded by the test runner. The decisions
// worth testing — does this grant authorize this capability, right now, and how
// long may it last — live here, where a test can reach them.
//
// THE ONE INVARIANT: a grant never outlives the token that asked for it.
// grantExpiry takes the minimum of "an hour from now" and the token's own `exp`,
// so a client cannot bank a long-lived write permission by presenting a token it
// is about to lose. Both bounds matter — the hour caps a long-lived token, the
// exp caps a short one.

// The capability vocabulary. Adding a write tool means adding a name here and
// naming it on the approval page — NOT reusing an existing one. A user who
// approved "write eval questions" has not approved anything else, and the whole
// point of storing a text[] instead of a boolean is that this stays true as
// tools are added.
export const WRITE_CAPABILITIES = ["questions_write", "config_create"] as const;

export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];

// Plain language for the approval screen. A user is being asked to authorize an
// effect, not a symbol, so this is the string they actually decide on.
export const CAPABILITY_LABELS: Record<WriteCapability, string> = {
  questions_write: "Write evaluation questions against your chunks",
  config_create: "Create new configs on your account",
};

export function isWriteCapability(value: unknown): value is WriteCapability {
  return (
    typeof value === "string" && (WRITE_CAPABILITIES as readonly string[]).includes(value)
  );
}

// The ceiling on any single approval. An hour is roughly one working session and
// roughly the Supabase access-token lifetime, so in practice the two bounds in
// grantExpiry expire together and re-approving is the same act as refreshing.
export const MAX_GRANT_MS = 60 * 60 * 1000;

// `tokenExpSeconds` is AuthInfo.expiresAt — seconds since epoch, straight off the
// JWT's `exp`. Undefined means the caller could not read one, which is treated as
// "no extra room", not "unlimited": the hour still applies and nothing longer is
// reachable by omitting the field.
export function grantExpiry(nowMs: number, tokenExpSeconds: number | undefined): Date {
  const ceiling = nowMs + MAX_GRANT_MS;
  if (typeof tokenExpSeconds !== "number" || !Number.isFinite(tokenExpSeconds)) {
    return new Date(ceiling);
  }
  return new Date(Math.min(ceiling, tokenExpSeconds * 1000));
}

export type WriteGrant = {
  clientId: string;
  capabilities: string[];
  grantedAt: Date;
  expiresAt: Date;
};

// Expiry is compared here as well as in SQL. The store's `expires_at > now()`
// predicate uses the DATABASE clock and this uses the app's; they agree to within
// clock skew, and both being present means a grant read for display and a grant
// checked for authorization can never disagree about whether it is live.
export function grantIsLive(grant: WriteGrant | null, nowMs: number): boolean {
  return grant !== null && grant.expiresAt.getTime() > nowMs;
}

// The authorization decision itself. Note it takes the grant already narrowed to
// ONE client_id by the caller — a grant for a different client is not "a grant
// that fails the check here", it is a row this function never sees, because the
// store keys on (user_id, client_id).
export function grantAllows(
  grant: WriteGrant | null,
  capability: WriteCapability,
  nowMs: number,
): boolean {
  if (!grantIsLive(grant, nowMs)) return false;
  return grant!.capabilities.includes(capability);
}
