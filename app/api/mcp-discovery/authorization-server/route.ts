// ---------------------------------------------------------------------------
// RFC 8414 AUTHORIZATION SERVER METADATA — a pass-through of Supabase's own.
//
// Reached at /.well-known/oauth-authorization-server via a rewrite in
// next.config.ts. Strictly speaking this should not be needed: the protected
// resource document next door names the Supabase issuer, and a spec-current
// client goes and asks Supabase directly. But older MCP clients predate RFC 9728
// and probe the RESOURCE's origin for authorization server metadata, so without
// this they conclude the server has no OAuth at all and give up.
//
// Serving it costs nothing — it is the same cached document the protected
// resource route already fetches — so the compatibility is close to free. It is
// a pass-through and not a rewrite of the contents: every endpoint in it points
// at Supabase, which is correct, because Supabase is the authorization server
// and we are only the resource.
//
// Unauthenticated, like its neighbour, and for the same reason: a client reads
// this before it could possibly hold a credential.
// ---------------------------------------------------------------------------
import { authorizationServerMetadata } from "@/lib/mcp/metadata";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function GET() {
  try {
    return Response.json(await authorizationServerMetadata(), { headers: CORS });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discovery metadata unavailable.";
    return Response.json({ error: message }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" },
  });
}
