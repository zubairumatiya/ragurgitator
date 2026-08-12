// THE `describe_authorization` TOOL PAYLOAD — what this connection may currently do.
//
// The tool a client calls BEFORE trying to write, and the one that makes a refusal
// self-service: it names the account, the client, when the token lapses, which write
// capabilities are live and until when, and the exact URL to open to change any of
// that. Without it "the write failed" is a dead end for both the model and the user.
//
// IT LISTS CAPABILITIES INDIVIDUALLY rather than reporting a boolean, so "what can
// this agent actually do right now" has a literal answer. That is the same reason
// 0060 stores a text[]: a user who approved question writing has not approved config
// creation, and any surface that blurs the two makes the distinction decorative.
//
// A LAPSED GRANT IS SHOWN, NOT HIDDEN. describeGrant deliberately returns expired
// rows, because "your approval ran out twelve minutes ago" is the answer to the most
// common failure, and filtering it out would turn that into a silent nothing.
import "server-only";

import { z } from "zod";

import { mcpEnabled } from "@/lib/http/mcpScope";
import { siteUrl } from "@/lib/mcp/metadata";
import { approvalUrl } from "@/lib/mcp/toolPolicy";
import { describeGrant } from "@/lib/mcp/writeGrant";
import {
  CAPABILITY_LABELS,
  WRITE_CAPABILITIES,
  type WriteCapability,
  grantIsLive,
  isWriteCapability,
} from "@/lib/mcp/writeGrantPolicy";

export const DescribeAuthorizationOutputSchema = z.object({
  account: z.object({
    email: z.string(),
    mcpEnabled: z.boolean().describe("The account-wide kill switch under Account → MCP access."),
  }),
  client: z.object({
    clientId: z.string(),
    tokenExpiresAt: z.string().nullable().describe("When this access token lapses."),
  }),
  write: z.object({
    granted: z.boolean().describe("Whether a live write grant exists for this client."),
    expiresAt: z.string().nullable(),
    grantedAt: z.string().nullable(),
    capabilities: z.array(
      z.object({
        capability: z.string(),
        label: z.string().describe("The wording the user approved it under."),
        granted: z.boolean(),
      }),
    ),
  }),
  links: z.object({
    approve: z.string().describe("Give this to the user to approve or change write access."),
    account: z.string().describe("Where to disconnect this client entirely."),
  }),
});

export type AuthorizationPayload = z.infer<typeof DescribeAuthorizationOutputSchema>;

const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;

export async function describeAuthorization(args: {
  userId: string;
  email: string;
  clientId: string;
  tokenExpSeconds?: number;
}): Promise<AuthorizationPayload> {
  const [enabled, grant] = await Promise.all([
    mcpEnabled(),
    describeGrant(args.userId, args.clientId),
  ]);

  const live = grantIsLive(grant, Date.now());
  // Only names this build knows. A stored capability the current code no longer
  // implements would otherwise be reported as something the agent can do.
  const held = new Set<WriteCapability>((grant?.capabilities ?? []).filter(isWriteCapability));

  return {
    account: { email: args.email, mcpEnabled: enabled },
    client: {
      clientId: args.clientId,
      tokenExpiresAt:
        typeof args.tokenExpSeconds === "number"
          ? new Date(args.tokenExpSeconds * 1000).toISOString()
          : null,
    },
    write: {
      granted: live,
      expiresAt: iso(grant?.expiresAt),
      grantedAt: iso(grant?.grantedAt),
      // Every capability, not just the held ones — the list doubles as the menu of
      // what could be asked for, which is what makes the approve link actionable.
      capabilities: WRITE_CAPABILITIES.map((capability) => ({
        capability,
        label: CAPABILITY_LABELS[capability],
        granted: live && held.has(capability),
      })),
    },
    links: {
      approve: approvalUrl(
        siteUrl(),
        args.clientId,
        [...WRITE_CAPABILITIES],
        args.tokenExpSeconds,
      ),
      account: `${siteUrl().replace(/\/+$/, "")}/account`,
    },
  };
}
