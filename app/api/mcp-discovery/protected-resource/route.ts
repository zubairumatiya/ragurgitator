// RFC 9728 PROTECTED RESOURCE METADATA — "who authorizes access to /api/mcp?"
//
// Reached at /.well-known/oauth-protected-resource/api/mcp via a rewrite in
// next.config.ts, not by living at that path. Dot-prefixed directories under
// app/ are not reliably routed, and the alternative — a catch-all that parses
// the path — buys nothing when there are exactly two documents to serve.
//
// UNAUTHENTICATED BY DESIGN, which is the whole point of the RFC: a client that
// has never seen this server hits /api/mcp, gets a 401 naming this URL, fetches
// it, and learns which authorization server to go and get a token from. Every
// step happens before it could possibly have a credential. proxy.ts has
// /.well-known in PUBLIC_PREFIXES for exactly this reason, and there is a
// matching HANDLER_EXEMPT entry in scripts/guards.ts.
//
// The document itself is derived, never hand-written: the SDK's builder also
// validates the issuer URL (HTTPS outside localhost, no fragment, no query), so
// a misconfigured Supabase project fails here with a clear message rather than
// three hops later inside somebody's agent.
import { buildOAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";

import { authorizationServerMetadata, mcpServerUrl } from "@/lib/mcp/metadata";

// Permissive CORS matches what the SDK's own metadata responses send: discovery
// documents are public by definition, and MCP clients running in a browser
// context need to read them cross-origin.
const CORS = { "Access-Control-Allow-Origin": "*" };

export async function GET() {
  try {
    const metadata = buildOAuthProtectedResourceMetadata({
      oauthMetadata: await authorizationServerMetadata(),
      resourceServerUrl: mcpServerUrl(),
      resourceName: "RAG",
    });
    return Response.json(metadata, { headers: CORS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discovery metadata unavailable.";
    return Response.json({ error: message }, { status: 500, headers: CORS });
  }
}

// Preflight, so a browser-based client can read the document.
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" },
  });
}
