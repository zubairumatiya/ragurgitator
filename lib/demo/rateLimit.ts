// PER-IP PROVISIONING LIMIT — what stops one visitor minting 500 workspaces.
//
// It is also what protects the 50,000 MAU allowance, which is the less obvious
// half: every guest burns one MAU, and deleting the account does not give it
// back. So the thing being rationed is not disk (the reaper handles that) but a
// monthly count that no cleanup can undo.
//
// IN THE DATABASE, NOT IN MEMORY. A Map on the instance would be reset by every
// cold start and would not be shared between the several instances Vercel runs
// at once — i.e. it would look like a rate limit while being roughly none. One
// indexed count against demo_provisions (0075) is exact across instances.
//
// THE ADDRESS IS HASHED, NEVER STORED. The only question ever asked is "how many
// from this address", which a salted hash answers exactly; keeping the raw IP
// would be personal data retained for no additional capability. The salt is its
// own env var so that rotating it — which resets every counter — is an operator
// action available on its own.
import "server-only";

import { createHash } from "node:crypto";

import { privilegedSql } from "@/lib/db";
import { demo, ipSalt } from "@/lib/demo/config";

// Vercel puts the client address in x-forwarded-for; the first entry is the
// visitor and the rest are proxies. Behind Cloudflare (which this deployment is,
// grey-clouded) cf-connecting-ip is the more trustworthy of the two, so it wins
// when present.
//
// A request with NO usable address is treated as one shared bucket rather than
// as exempt. Unattributable traffic sharing a single quota is the conservative
// reading; the alternative — no header, no limit — is the one an abuser would
// arrange for.
export function clientAddress(request: Request): string {
  const h = request.headers;
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return h.get("x-real-ip")?.trim() || "unknown";
}

function hashOf(address: string): string {
  return createHash("sha256").update(`${ipSalt() ?? ""}:${address}`).digest("hex");
}

// Has this address already had its allowance? Asked BEFORE anything is created,
// so a refusal costs nothing.
export async function overIpLimit(address: string): Promise<boolean> {
  const [row] = await privilegedSql<{ n: string }[]>`
    select count(*)::text as n
      from demo_provisions
     where ip_hash = ${hashOf(address)}
       and created_at > now() - make_interval(mins => ${demo.ipWindowMinutes}::int)
  `;
  return Number(row?.n ?? 0) >= demo.perIpPerWindow;
}

// Recorded on SUCCESS only. A provisioning attempt that failed halfway gave the
// visitor nothing, and charging them for it would turn one transient Key Vault
// error into a day-long lockout.
export async function recordProvision(address: string): Promise<void> {
  await privilegedSql`
    insert into demo_provisions (ip_hash) values (${hashOf(address)})
  `;
}

// Housekeeping: rows older than the window answer no question. Folded into the
// same daily cron as the reaper rather than given a schedule of its own.
export async function pruneProvisionLedger(): Promise<number> {
  const result = await privilegedSql`
    delete from demo_provisions
     where created_at < now() - make_interval(mins => ${demo.ipWindowMinutes * 2}::int)
  `;
  return result.count ?? 0;
}
