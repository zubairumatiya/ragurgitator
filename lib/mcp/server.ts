// THE MCP SERVER INSTANCE — tool registration and the per-request factory.
//
// createMcpHandler calls this factory once per HTTP request rather than holding
// one long-lived server, which is what makes a multi-tenant MCP endpoint safe on
// a shared process: the instance is constructed around ONE caller's identity and
// is discarded with the response, so there is no server object that could
// outlive a request and answer the next one with the last one's user.
//
// That is also why the tool closure captures `user` instead of reading it from
// some ambient place at call time. The identity arrives on the verified token
// (lib/auth/mcpToken.ts), is handed to the factory as ctx.authInfo, and is bound
// here — one hop, no globals.
import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { RequestUser } from "@/lib/auth/userScope";
import { withMcpUser } from "@/lib/http/mcpScope";
import { DescribeOutputSchema, describeConfig } from "@/lib/mcp/describeConfig";

const INPUT = z.object({
  configId: z
    .string()
    .optional()
    .describe("The config to describe. Omit to list the available configs first."),
});

const DESCRIPTION = [
  "Describe one retrieval config in this RAG app: its chunking and model settings,",
  "the documents ingested under it, per-chunk model overrides, itemized cost savings,",
  "and the latest evaluation scores.",
  "Call with no arguments to get back `configs` and `hint` — the list of config ids and labels.",
  "Call with a configId to get back the full summary instead: `config`, `retrieval`, `corpus`,",
  "`documents`, `overrides`, `costs` and `evaluation`.",
  "Returns configuration and metrics only — never document or chunk text.",
].join(" ");

export function buildMcpServer(user: RequestUser): McpServer {
  const server = new McpServer({ name: "rag", version: "1.0.0" });

  server.registerTool(
    "describe_config",
    {
      title: "Describe a config",
      description: DESCRIPTION,
      inputSchema: INPUT,
      outputSchema: DescribeOutputSchema,
      // readOnlyHint lets a client say so in its own consent UI, and lets an
      // agent skip asking permission for something that cannot change state.
      // It is a claim we have to keep true: nothing under describeConfig writes.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ configId }) => {
      const result = await withMcpUser(user, () => describeConfig(configId));

      // withMcpUser's union return exists so an HTTP caller can't drop a
      // Response on the floor. Inside a tool there is no HTTP response to
      // return, and the only thing that produces one here is the missing-key
      // path — which describe_config can't reach, because it calls no provider.
      // If that ever changes, this is where it surfaces rather than leaking a
      // Response object into a JSON-RPC result.
      if (result instanceof Response) {
        return errorResult("This tool needs a provider key that isn't configured on your account.");
      }

      if (!result.ok) return errorResult(result.error);

      const payload = "picker" in result ? result.picker : result.description;
      return {
        // Both shapes on purpose: structuredContent is what a 2026-spec client
        // reads, and the text mirror is what everything older shows the model.
        // Sending only one means half the clients get nothing useful.
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

// A tool-level failure, not a protocol-level one: `isError` puts the message in
// front of the model so it can correct itself (ask for the list, pick a real
// id), where a thrown JSON-RPC error would just look like the server broke.
const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
