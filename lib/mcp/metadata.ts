// OAUTH DISCOVERY — the URLs the whole flow is pinned to, and Supabase's own
// authorization-server metadata.
//
// Shared between the MCP route (which advertises the metadata URL in its 401
// challenge) and the two discovery routes (which serve the documents). They have
// to agree exactly: a client reads the URL out of the challenge and fetches it,
// so a mismatch is a flow that dead-ends with a correct-looking 401.
//
// RESOURCE IDENTIFIER. Under RFC 9728 the resource server is identified by its
// URL, and the well-known path is derived by inserting
// `/.well-known/oauth-protected-resource` ahead of the path — so /api/mcp is
// published at /.well-known/oauth-protected-resource/api/mcp. That derivation is
// the SDK's; we don't hand-write either string, because writing them twice is
// how they drift apart.
//
// WHY WE FETCH SUPABASE'S METADATA RATHER THAN HARDCODING ITS ENDPOINTS. The
// protected-resource document only needs the ISSUER, but the SDK's builder takes
// a whole RFC 8414 metadata object, and inventing plausible-looking
// authorization_endpoint / token_endpoint values to satisfy the type would be
// writing down guesses about somebody else's server. Supabase publishes the real
// document; we read it and cache it. That also makes the authorization-server
// pass-through route free, since it is the same document.
//
// The cache is a module-scope promise, so concurrent cold requests share one
// fetch and a FAILED fetch is discarded rather than memoised — a transient
// network blip during boot must not poison discovery for the life of the
// process.
import { type OAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";

// Falls back to the dev port rather than throwing, matching app/auth/actions.ts.
// A missing site URL should not take the app down at import time; it should make
// local development work and production discovery obviously wrong.
export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
}

export function mcpServerUrl(): URL {
  return new URL("/api/mcp", siteUrl());
}

export function issuerUrl(): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabase) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set, so the MCP server cannot name its authorization " +
        "server. Copy it from the Supabase dashboard (Project Settings → API) into .env.local.",
    );
  }
  return `${supabase.replace(/\/+$/, "")}/auth/v1`;
}

export function resourceMetadataUrl(): string {
  return getOAuthProtectedResourceMetadataUrl(mcpServerUrl());
}

let cached: Promise<OAuthMetadata> | null = null;

export function authorizationServerMetadata(): Promise<OAuthMetadata> {
  if (!cached) {
    cached = fetchAuthorizationServerMetadata().catch((err) => {
      cached = null; // don't memoise a failure
      throw err;
    });
  }
  return cached;
}

async function fetchAuthorizationServerMetadata(): Promise<OAuthMetadata> {
  const issuer = issuerUrl();
  const url = `${issuer}/.well-known/oauth-authorization-server`;

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    // Supabase names this failure precisely when it is the expected one — a
    // project with the OAuth server switched off answers
    // { code: 404, error_code: "feature_disabled", msg: "OAuth server is disabled" }.
    // Passing its own message through beats guessing from the status code, and
    // beats a bare 404, which is completely opaque about what to go and fix.
    const detail = await supabaseErrorDetail(response);
    throw new Error(
      `Could not read the authorization server metadata at ${url} (HTTP ${response.status}` +
        `${detail ? `: ${detail}` : ""}). Enable the OAuth server for this Supabase project ` +
        "under Authentication → OAuth Server, and turn on dynamic client registration.",
    );
  }

  const metadata = (await response.json()) as OAuthMetadata;
  if (typeof metadata?.issuer !== "string") {
    throw new Error(`The metadata document at ${url} has no issuer.`);
  }
  return metadata;
}

// Best-effort: pull Supabase's own words out of an error body. Never throws — a
// diagnostic helper that can fail while building an error message would replace
// the real problem with its own.
async function supabaseErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { msg?: unknown; error_code?: unknown };
    const msg = typeof body.msg === "string" ? body.msg : null;
    const code = typeof body.error_code === "string" ? body.error_code : null;
    if (msg && code) return `${msg} (${code})`;
    return msg ?? code;
  } catch {
    return null;
  }
}
