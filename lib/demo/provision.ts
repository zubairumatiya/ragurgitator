// PROVISIONING A GUEST — identity, key, clone, in that order.
//
// The order is not arbitrary. The key is sealed BEFORE the clone because sealing
// is the only step that can fail for reasons outside this database (Voyage's
// verify call, an Azure Key Vault wrap), and failing before 8 MB of rows have
// been written is cheaper to undo than failing after.
//
// EVERY FAILURE PATH DELETES THE AUTH USER. A half-provisioned guest is worse
// than none: it holds an MAU, it may hold a Voyage key, and nothing will ever
// clean it up because it has no expiry yet. The rollback is one statement
// because the cascade is already declared (auth.users → user_profiles →
// everything), which is the same property account deletion relies on.
import "server-only";

import { saveProviderKey } from "@/lib/auth/providerKeys";
import { withUser } from "@/lib/auth/userScope";
import { privilegedSql } from "@/lib/db";
import { createGuestAuthUser } from "@/lib/demo/admin";
import { cloneSeedWorkspace, type CloneSummary } from "@/lib/demo/clone";
import { demo, demoDisabledReason, demoEnabled, demoVoyageKey, seedUserId } from "@/lib/demo/config";
import { liveGuestCount, reapExpiredGuests } from "@/lib/demo/guest";
import { overIpLimit, pruneProvisionLedger, recordProvision } from "@/lib/demo/rateLimit";

export type ProvisionResult =
  | { ok: true; email: string; password: string; expiresAt: string; clone: CloneSummary }
  // `retryable` separates "come back later" (the demo is full) from "no"
  // (you've had your three), so the page can word the two differently.
  | { ok: false; message: string; retryable: boolean };

// A guest workspace, ready to sign into. The caller signs in with the returned
// credentials — this function deliberately does not touch cookies, so it is
// testable and so the one place that writes a session stays the route handler.
export async function provisionGuest(address: string): Promise<ProvisionResult> {
  if (!demoEnabled()) {
    // An operator-facing reason in the log, a flat "unavailable" to the visitor:
    // a misconfigured demo should look like no demo from outside.
    console.warn(`[demo] provisioning refused — ${demoDisabledReason()}`);
    return { ok: false, message: "The demo is not available right now.", retryable: false };
  }

  // Sweep first, and this is what makes a two-hour TTL mean two hours. Vercel's
  // Hobby plan permits nothing more frequent than a daily cron, so a cron-only
  // reaper would let expired guests linger for up to 24 hours and hold the cap
  // shut. Reaping on each provision is cheap (one indexed delete), self-limiting
  // (it only runs when someone arrives) and puts the sweep exactly where the
  // space is about to be needed.
  await reapExpiredGuests().catch((e) => {
    console.warn(`[demo] reap before provision failed: ${String(e)}`);
    return 0;
  });

  if (await overIpLimit(address)) {
    return {
      ok: false,
      message:
        "You've already started a few demo workspaces from this connection. " +
        "Sign up for a free account to keep going.",
      retryable: false,
    };
  }

  if ((await liveGuestCount()) >= demo.maxLiveGuests) {
    return {
      ok: false,
      message:
        "The demo is at capacity — every workspace is a real copy of the corpus, " +
        "and there's only so much room. Try again in an hour.",
      retryable: true,
    };
  }

  const seed = seedUserId()!;
  const guest = await createGuestAuthUser();
  const expiresAt = new Date(Date.now() + demo.ttlMinutes * 60_000);

  try {
    // The guest FLAG AND THE EXPIRY, written as `postgres`. They are
    // operator-owned columns (0075's trigger refuses them from rag_app), which
    // is what makes "guest extends own TTL" unrepresentable rather than merely
    // unreachable.
    await privilegedSql`
      update user_profiles
         set is_guest = true, expires_at = ${expiresAt}
       where id = ${guest.id}
    `;

    // SEALED PER GUEST, THROUGH THE ORDINARY PATH — and re-sealing is not the
    // tidier of two options, it is the only one. aadFor(userId, provider) binds
    // the AAD to the user id precisely so that a row copied from one tenant to
    // another fails its GCM tag check, so cloning user_provider_keys in SQL
    // alongside everything else is defeated by design — and would fail at first
    // use rather than at clone time.
    //
    // The reward is that NOTHING ELSE IN THE APP CHANGES: no branch inside
    // lib/llm/client.ts, no new .expose() site for scripts/guards.ts to flag,
    // keyLastFourFor attributes usage normally, and /account renders the key
    // like any other. A server-key fallback inside cached() would have put a
    // special case in the most security-critical function in the codebase to
    // save rows that get deleted anyway.
    //
    // It is also the step with network calls in it — verifyProviderKey hits
    // Voyage, then Key Vault wraps the DEK — so it is the one to budget latency
    // for and the one most likely to fail.
    const saved = await withUser({ id: guest.id, email: guest.email }, () =>
      saveProviderKey(guest.id, "voyage", demoVoyageKey()!),
    );
    if (!saved.ok) throw new Error(`sealing the demo Voyage key failed: ${saved.message}`);

    const clone = await cloneSeedWorkspace(seed, guest.id);

    // Recorded on success only — a failed attempt gave the visitor nothing, and
    // charging them for it turns one transient Key Vault error into a day-long
    // lockout.
    await recordProvision(address);
    await pruneProvisionLedger().catch(() => 0);

    return {
      ok: true,
      email: guest.email,
      password: guest.password,
      expiresAt: expiresAt.toISOString(),
      clone,
    };
  } catch (err) {
    console.error(`[demo] provisioning failed for ${guest.id}: ${String(err)}`);
    // One statement, because the cascade is declared. If THIS fails the guest is
    // still expiring — the flag and expiry were the first thing written — so the
    // reaper collects it within the TTL either way.
    await privilegedSql`delete from auth.users where id = ${guest.id}`.catch((e) =>
      console.error(`[demo] rollback of ${guest.id} failed: ${String(e)}`),
    );
    return {
      ok: false,
      message: "Something went wrong setting up the demo. Try again in a moment.",
      retryable: true,
    };
  }
}
