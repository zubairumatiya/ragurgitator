// THE MCP SERVER INSTANCE — tool registration and the per-request factory.
//
// createMcpHandler calls this factory once per HTTP request rather than holding one
// long-lived server, which is what makes a multi-tenant MCP endpoint safe on a
// shared process: the instance is constructed around ONE caller's identity and is
// discarded with the response.
//
// That is also why the tool closures capture `session` instead of reading it from
// some ambient place at call time. Identity, client_id and token expiry all arrive
// on the verified token, are handed to the factory as ctx.authInfo, and are bound
// here — one hop, no globals. The expiry matters as much as the identity: it caps
// how long a write grant approved during this session may last (writeGrantPolicy.ts).
//
// WHAT THE TOOL SURFACE NOW IS, and how it changed. describe_config was read-only
// and corpus-blind. list_chunks returns passage text and two tools write, so the
// consent question this server poses is larger than it was — see listChunks.ts for
// the boundary note and addQuestions.ts for the second gate that guards the writes.
import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { RequestUser } from "@/lib/auth/userScope";
import { withMcpUser } from "@/lib/http/mcpScope";
import { AddQuestionsOutputSchema, QuestionInput, addQuestions } from "@/lib/mcp/addQuestions";
import {
  CreateConfigInput,
  CreateConfigOutputSchema,
  createConfigForAgent,
} from "@/lib/mcp/createConfig";
import {
  DescribeAuthorizationOutputSchema,
  describeAuthorization,
} from "@/lib/mcp/describeAuthorization";
import { DescribeOutputSchema, describeConfig } from "@/lib/mcp/describeConfig";
import { ListChunksOutputSchema, listChunks } from "@/lib/mcp/listChunks";
import { DEFAULT_CHUNK_PAGE, MAX_CHUNK_PAGE, MAX_QUESTION_BATCH } from "@/lib/mcp/toolPolicy";

// Everything a tool body needs about the caller, lifted off the verified token.
// `tokenExpSeconds` is AuthInfo.expiresAt straight from the JWT's `exp`.
export type McpSession = {
  user: RequestUser;
  clientId: string;
  tokenExpSeconds?: number;
};

const DESCRIBE_INPUT = z.object({
  configId: z
    .string()
    .optional()
    .describe("The config to describe. Omit to list the available configs first."),
});

const DESCRIBE_DESCRIPTION = [
  "Describe one retrieval config in this RAG app: its chunking and model settings,",
  "the documents ingested under it, per-chunk model overrides, itemized cost savings,",
  "and the latest evaluation scores.",
  "Call with no arguments to get back `configs` and `hint` — the list of config ids and labels.",
  "Call with a configId to get back the full summary instead: `config`, `retrieval`, `corpus`,",
  "`documents`, `overrides`, `costs` and `evaluation`.",
  // This used to promise "never document or chunk text" and no longer can: the
  // corpus is readable through list_chunks. Saying "counts and settings" keeps
  // the description true of THIS tool without implying a server-wide boundary
  // that has moved.
  "Returns counts and settings only — for the passages themselves, use list_chunks.",
].join(" ");

const LIST_CHUNKS_INPUT = z.object({
  configId: z.string().describe("The config whose chunks to read."),
  offset: z.number().int().min(0).optional().describe("Start of the page. Default 0."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(`Page size. Default ${DEFAULT_CHUNK_PAGE}, capped at ${MAX_CHUNK_PAGE}.`),
  documentId: z.string().optional().describe("Narrow to one document. Omit for the whole corpus."),
});

const ADD_QUESTIONS_INPUT = z.object({
  configId: z.string().describe("The config the questions are labeled under."),
  questions: z.array(QuestionInput).min(1).max(MAX_QUESTION_BATCH),
});

const ADD_QUESTIONS_DESCRIPTION = [
  "Add evaluation questions to a config, each labeled to the chunk that uniquely answers it.",
  "WRITES to the user's data: needs a `questions_write` grant, which the user approves in a",
  "browser and which expires within the hour. Call describe_authorization first to check, and",
  "to get the approval link if there is no live grant.",
  `Batched (up to ${MAX_QUESTION_BATCH} per call) and partially failable: each item comes back`,
  "with its own ok/error, so a stale chunk id does not discard the rest of the batch.",
  "Write questions whose answer is found uniquely in the labeled chunk and nowhere else — a",
  "question answerable from several chunks corrupts the ground truth for every later metric.",
].join(" ");

export function buildMcpServer(session: McpSession): McpServer {
  const server = new McpServer({ name: "rag", version: "1.0.0" });
  const { user } = session;

  server.registerTool(
    "describe_config",
    {
      title: "Describe a config",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: DESCRIBE_INPUT,
      outputSchema: DescribeOutputSchema,
      // readOnlyHint lets a client say so in its own consent UI, and lets an
      // agent skip asking permission for something that cannot change state.
      // It is a claim we have to keep true: nothing under describeConfig writes.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ configId }) => {
      const result = await withMcpUser(user, () => describeConfig(configId));
      if (result instanceof Response) return missingKey();
      if (!result.ok) return errorResult(result.error);
      return payload("picker" in result ? result.picker : result.description);
    },
  );

  server.registerTool(
    "list_chunks",
    {
      title: "List a config's chunks",
      description: [
        "Read one page of a config's chunks — the passages retrieval actually searches —",
        "with the text, the document it came from, and how many eval questions already",
        "point at it. Page with `nextOffset` until it comes back null.",
        "Read-only. Its purpose is to give an agent the passages it needs before calling",
        "add_questions.",
      ].join(" "),
      inputSchema: LIST_CHUNKS_INPUT,
      outputSchema: ListChunksOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await withMcpUser(user, () => listChunks(args));
      if (result instanceof Response) return missingKey();
      if (!result.ok) return errorResult(result.error);
      return payload(result.page);
    },
  );

  server.registerTool(
    "add_questions",
    {
      title: "Add evaluation questions",
      description: ADD_QUESTIONS_DESCRIPTION,
      inputSchema: ADD_QUESTIONS_INPUT,
      outputSchema: AddQuestionsOutputSchema,
      // The annotation is advisory; the grant check in addQuestions is the actual
      // gate. Both are needed — this one is what a client shows a user before the
      // call, that one is what happens if the client shows nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ configId, questions }) => {
      const result = await withMcpUser(user, () =>
        addQuestions({
          configId,
          questions,
          userId: user.id,
          clientId: session.clientId,
          tokenExpSeconds: session.tokenExpSeconds,
        }),
      );
      if (result instanceof Response) return missingKey();
      if (!result.ok) return errorResult(result.error);
      return payload(result.payload);
    },
  );

  server.registerTool(
    "create_config",
    {
      title: "Create a config",
      description: [
        "Create a new, EMPTY retrieval config with the given chunking and model settings.",
        "WRITES to the user's data: needs a `config_create` grant — see describe_authorization.",
        "The config starts with no documents; upload them through the web app afterwards,",
        "since ingest streams progress and takes multipart uploads.",
        "`baseModel` must be one the account has a working provider key for.",
      ].join(" "),
      inputSchema: CreateConfigInput,
      outputSchema: CreateConfigOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await withMcpUser(user, () =>
        createConfigForAgent({
          input,
          userId: user.id,
          clientId: session.clientId,
          tokenExpSeconds: session.tokenExpSeconds,
        }),
      );
      if (result instanceof Response) return missingKey();
      if (!result.ok) return errorResult(result.error);
      return payload(result.payload);
    },
  );

  server.registerTool(
    "describe_authorization",
    {
      title: "What this connection may do",
      description: [
        "Report what this connection is currently authorized to do: the account it acts for,",
        "the client id, when the access token expires, which write capabilities are granted",
        "and until when, and the links to approve write access or disconnect entirely.",
        "Call this before any write, and after a write is refused — the approval link it",
        "returns is what the user opens to fix it.",
      ].join(" "),
      inputSchema: z.object({}),
      outputSchema: DescribeAuthorizationOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await withMcpUser(user, () =>
        describeAuthorization({
          userId: user.id,
          email: user.email,
          clientId: session.clientId,
          tokenExpSeconds: session.tokenExpSeconds,
        }),
      );
      if (result instanceof Response) return missingKey();
      return payload(result);
    },
  );

  return server;
}

// Both shapes on purpose: structuredContent is what a 2026-spec client reads, and
// the text mirror is what everything older shows the model. Sending only one means
// half the clients get nothing useful.
const payload = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

// A tool-level failure, not a protocol-level one: `isError` puts the message in
// front of the model so it can correct itself (ask for the list, pick a real
// id, get the grant approved), where a thrown JSON-RPC error would just look like
// the server broke.
const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

// withMcpUser's union return exists so an HTTP caller can't drop a Response on the
// floor. Inside a tool there is no HTTP response to return, and the only thing that
// produces one is the missing-provider-key path — reachable here only through
// create_config's availability check. Surfacing it as a tool error keeps a Response
// object from leaking into a JSON-RPC result.
const missingKey = () =>
  errorResult("This tool needs a provider key that isn't configured on your account.");
