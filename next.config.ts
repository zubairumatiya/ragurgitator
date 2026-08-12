import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // voyageai@0.2.1 ships an ESM build with bad imports (missing .mjs extensions
  // in dist/esm/extended/index.mjs). Leaving the package external on the server
  // bypasses bundling so Node resolves the working CJS entry instead.
  serverExternalPackages: ["voyageai"],

  // OAuth discovery for the MCP server (app/api/mcp). RFC 9728 fixes these paths
  // under /.well-known, and a client fetches them before it holds any credential
  // — they are not ours to choose or to move.
  //
  // REWRITES RATHER THAN REAL DIRECTORIES because a dot-prefixed folder under
  // app/ is not reliably routed. The handlers therefore live at ordinary paths
  // (app/api/mcp-discovery/*) and these map the spec's paths onto them.
  //
  // Note the proxy runs BEFORE rewrites in Next's execution order, so
  // /.well-known also has to be in PUBLIC_PREFIXES in proxy.ts or an
  // unauthenticated agent gets redirected to /login before it ever gets here.
  async rewrites() {
    return [
      {
        // Path-aware per RFC 9728: the resource's path (/api/mcp) is appended.
        // The bare form is served too, for clients that probe the origin root.
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/mcp-discovery/protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/mcp-discovery/protected-resource",
      },
      {
        // Pre-RFC-9728 clients probe the resource origin for the authorization
        // server document, in both the bare and path-suffixed forms.
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/mcp-discovery/authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server/api/mcp",
        destination: "/api/mcp-discovery/authorization-server",
      },
    ];
  },
};

export default nextConfig;
