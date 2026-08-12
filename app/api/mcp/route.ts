// ---------------------------------------------------------------------------
// THE MCP ENDPOINT. JSON-RPC over HTTP, authenticated by an OAuth bearer token.
//
// This is the only route in the app not behind a session cookie, which is the
// entire reason it exists — an agent running in someone's terminal has no cookie
// jar. The authentication boundary is withMcpRequest (lib/http/mcpScope.ts), the
// bearer-token counterpart of the cookie wrappers: it verifies the token, refuses
// anything without a client_id claim, and enforces the mcp_enabled kill switch
// before a single JSON-RPC byte is parsed.
//
// The handler is built ONCE at module scope but the McpServer inside it is built
// PER REQUEST, from the identity on that request's token. That is what makes a
// multi-tenant MCP endpoint safe on a shared process: there is no server object
// that could outlive a request and answer the next one as the previous user.
//
// No `export const runtime`: Node is already the default, and postgres.js plus
// AsyncLocalStorage rule out edge anyway. There is no runtime export anywhere
// else in this repo and this is not the file to start.
// ---------------------------------------------------------------------------
import { createMcpHandler } from "@modelcontextprotocol/server";

import { mcpIdentity } from "@/lib/auth/mcpToken";
import { withMcpRequest } from "@/lib/http/mcpScope";
import { buildMcpServer } from "@/lib/mcp/server";

const handler = createMcpHandler((ctx) => {
  const identity = mcpIdentity(ctx.authInfo?.extra);
  if (!identity) {
    // Unreachable through withMcpRequest, which checks the same thing first.
    // Throwing rather than substituting an anonymous server means a future
    // caller that forgets to pass authInfo fails loudly instead of quietly
    // building a server bound to nobody.
    throw new Error("MCP server factory called without a verified identity.");
  }
  return buildMcpServer({ id: identity.userId, email: identity.email });
});

// All three verbs go to the same handler. Under the SDK's default stateless
// posture it answers GET and DELETE — the 2025-era session verbs — with its own
// 405, which is more accurate than Next's "no such method" would be.
export async function POST(request: Request) {
  return withMcpRequest(request, (auth) => handler.fetch(request, { authInfo: auth }));
}

export async function GET(request: Request) {
  return withMcpRequest(request, (auth) => handler.fetch(request, { authInfo: auth }));
}

export async function DELETE(request: Request) {
  return withMcpRequest(request, (auth) => handler.fetch(request, { authInfo: auth }));
}
